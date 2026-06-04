/**
 * scripts/reconcile-container-configs.ts
 *
 * Git-driven group container-config. Reconciles a committed desired-state file
 * (`groups.config.json`, keyed by group FOLDER — never the install-specific
 * agent_group_id) into the `container_configs` table of the central DB.
 *
 * Modes:
 *   export            Dump current DB container_configs → groups.config.json shape
 *                     (stdout, or --write to overwrite the file). Used once to
 *                     bootstrap the file accurately from the live DB.
 *   apply             Upsert each file entry into the DB. Only fields present in
 *                     the file are written. --dry-run prints a field-level diff
 *                     and writes nothing.
 *
 * Safety:
 *   - Upsert-only. A group in the DB but absent from the file is left untouched.
 *   - A folder in the file with no matching DB group is a no-op warning (never
 *     auto-creates a group).
 *   - Only container_configs columns are written — never tasks/ or CLAUDE.local.md.
 *
 * Usage:
 *   pnpm exec tsx scripts/reconcile-container-configs.ts export [--write] [--file <path>]
 *   pnpm exec tsx scripts/reconcile-container-configs.ts apply  [--dry-run] [--file <path>]
 */
import fs from 'fs';
import path from 'path';

import { DATA_DIR, GROUPS_DIR } from '../src/config.js';
import { getAllAgentGroups, getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  getContainerConfig,
  ensureContainerConfig,
  updateContainerConfigScalars,
  updateContainerConfigJson,
} from '../src/db/container-configs.js';
import type { ContainerConfigRow } from '../src/types.js';

interface GroupConfigEntry {
  model?: string | null;
  effort?: string | null;
  provider?: string | null;
  assistantName?: string | null;
  cliScope?: string | null;
  maxMessagesPerPrompt?: number | null;
  skills?: string[] | 'all';
  mcpServers?: Record<string, unknown>;
  packages?: { apt?: string[]; npm?: string[] };
  additionalMounts?: unknown[];
  // NOTE: image_tag is intentionally NOT here. It is runtime-derived (encodes a
  // checkout hash + agent_group_id, regenerated on every container build), so it
  // is neither exported nor reconciled — git must never fight the live image tag.
}

interface GroupsConfigFile {
  version: number;
  groups: Record<string, GroupConfigEntry>;
}

const DEFAULT_FILE = path.resolve(GROUPS_DIR, '..', 'groups.config.json');

function parseArgs(argv: string[]): { mode: string; dryRun: boolean; write: boolean; file: string } {
  const mode = argv[0] ?? '';
  let file = DEFAULT_FILE;
  const fileIdx = argv.indexOf('--file');
  if (fileIdx !== -1 && argv[fileIdx + 1]) file = path.resolve(argv[fileIdx + 1]);
  return {
    mode,
    dryRun: argv.includes('--dry-run'),
    write: argv.includes('--write'),
    file,
  };
}

/** Stable stringify (recursively sorted keys) — for order-insensitive JSON comparison. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)));
    }
    return v;
  });
}

const SCALAR_MAP: Array<{ file: keyof GroupConfigEntry; col: keyof ContainerConfigRow }> = [
  { file: 'provider', col: 'provider' },
  { file: 'model', col: 'model' },
  { file: 'effort', col: 'effort' },
  { file: 'assistantName', col: 'assistant_name' },
  { file: 'maxMessagesPerPrompt', col: 'max_messages_per_prompt' },
  { file: 'cliScope', col: 'cli_scope' },
];

const JSON_MAP: Array<{
  label: string;
  col: 'skills' | 'mcp_servers' | 'packages_apt' | 'packages_npm' | 'additional_mounts';
  get: (e: GroupConfigEntry) => unknown;
  present: (e: GroupConfigEntry) => boolean;
}> = [
  { label: 'skills', col: 'skills', get: (e) => e.skills, present: (e) => e.skills !== undefined },
  { label: 'mcpServers', col: 'mcp_servers', get: (e) => e.mcpServers, present: (e) => e.mcpServers !== undefined },
  {
    label: 'packages.apt',
    col: 'packages_apt',
    get: (e) => e.packages?.apt,
    present: (e) => e.packages?.apt !== undefined,
  },
  {
    label: 'packages.npm',
    col: 'packages_npm',
    get: (e) => e.packages?.npm,
    present: (e) => e.packages?.npm !== undefined,
  },
  {
    label: 'additionalMounts',
    col: 'additional_mounts',
    get: (e) => e.additionalMounts,
    present: (e) => e.additionalMounts !== undefined,
  },
];

function rowToEntry(row: ContainerConfigRow): GroupConfigEntry {
  const entry: GroupConfigEntry = {
    skills: JSON.parse(row.skills) as string[] | 'all',
    mcpServers: JSON.parse(row.mcp_servers) as Record<string, unknown>,
    packages: { apt: JSON.parse(row.packages_apt) as string[], npm: JSON.parse(row.packages_npm) as string[] },
    additionalMounts: JSON.parse(row.additional_mounts) as unknown[],
  };
  if (row.provider !== null) entry.provider = row.provider;
  if (row.model !== null) entry.model = row.model;
  if (row.effort !== null) entry.effort = row.effort;
  // image_tag intentionally omitted — runtime-derived, never reconciled.
  if (row.assistant_name !== null) entry.assistantName = row.assistant_name;
  if (row.max_messages_per_prompt !== null) entry.maxMessagesPerPrompt = row.max_messages_per_prompt;
  if (row.cli_scope) entry.cliScope = row.cli_scope;
  return entry;
}

function doExport(file: string, write: boolean): void {
  const groups = getAllAgentGroups();
  const out: GroupsConfigFile = { version: 1, groups: {} };
  for (const g of groups) {
    const row = getContainerConfig(g.id);
    if (!row) continue;
    out.groups[g.folder] = rowToEntry(row);
  }
  const text = JSON.stringify(out, null, 2) + '\n';
  if (write) {
    fs.writeFileSync(file, text);
    console.log(`Wrote ${Object.keys(out.groups).length} group(s) → ${file}`);
  } else {
    process.stdout.write(text);
  }
}

function doApply(file: string, dryRun: boolean): number {
  if (!fs.existsSync(file)) {
    console.error(`groups.config.json not found at ${file} — nothing to reconcile.`);
    return 0;
  }
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as GroupsConfigFile;
  if (!parsed.groups || typeof parsed.groups !== 'object') {
    throw new Error('groups.config.json: missing "groups" object');
  }

  const dbGroups = getAllAgentGroups();
  const inFile = new Set(Object.keys(parsed.groups));
  let totalChanges = 0;

  for (const [folder, entry] of Object.entries(parsed.groups)) {
    const group = getAgentGroupByFolder(folder);
    if (!group) {
      console.warn(`⚠ "${folder}": no matching agent group in DB — skipped (groups are never auto-created).`);
      continue;
    }

    ensureContainerConfig(group.id);
    const current = getContainerConfig(group.id)!;
    const changes: string[] = [];

    // Scalars
    const scalarUpdates: Record<string, unknown> = {};
    for (const { file: f, col } of SCALAR_MAP) {
      if (entry[f] === undefined) continue;
      const desired = entry[f] ?? null;
      const cur = current[col] ?? null;
      if (desired !== cur) {
        changes.push(`  ${String(col)}: ${JSON.stringify(cur)} → ${JSON.stringify(desired)}`);
        scalarUpdates[col] = desired;
      }
    }

    // JSON columns
    const jsonApplies: Array<{ col: JSON_MapCol; value: unknown }> = [];
    for (const j of JSON_MAP) {
      if (!j.present(entry)) continue;
      const desired = j.get(entry);
      const cur = JSON.parse(current[j.col]) as unknown;
      if (stable(desired) !== stable(cur)) {
        changes.push(`  ${j.label}: ${truncate(stable(cur))} → ${truncate(stable(desired))}`);
        jsonApplies.push({ col: j.col, value: desired });
      }
    }

    if (changes.length === 0) {
      console.log(`✓ ${folder}: no changes`);
      continue;
    }
    totalChanges += changes.length;
    console.log(`${dryRun ? '~' : '✎'} ${folder}:`);
    for (const c of changes) console.log(c);

    if (!dryRun) {
      if (Object.keys(scalarUpdates).length > 0) updateContainerConfigScalars(group.id, scalarUpdates);
      for (const { col, value } of jsonApplies) updateContainerConfigJson(group.id, col, value);
    }
  }

  // Report DB groups absent from the file (left untouched).
  for (const g of dbGroups) {
    if (!inFile.has(g.folder)) console.log(`· ${g.folder}: not in file — left untouched`);
  }

  console.log(
    dryRun
      ? `\nDry run: ${totalChanges} field change(s) would be applied.`
      : `\nApplied ${totalChanges} field change(s). Takes effect on each group's next container spawn.`,
  );
  return totalChanges;
}

type JSON_MapCol = 'skills' | 'mcp_servers' | 'packages_apt' | 'packages_npm' | 'additional_mounts';

function truncate(s: string, n = 80): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
}

function main(): void {
  const { mode, dryRun, write, file } = parseArgs(process.argv.slice(2));
  initDb(path.join(DATA_DIR, 'v2.db'));

  switch (mode) {
    case 'export':
      doExport(file, write);
      break;
    case 'apply':
      doApply(file, dryRun);
      break;
    default:
      console.error('Usage: reconcile-container-configs.ts <export|apply> [--dry-run] [--write] [--file <path>]');
      process.exit(2);
  }
}

main();

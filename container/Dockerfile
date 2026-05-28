# syntax=docker/dockerfile:1.7
# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation.
#
# Runtime split:
#   - agent-runner (our TypeScript code): Bun, mounted RO at /app/src by host
#   - globally-installed Node CLIs (claude-code, agent-browser, vercel): pnpm + Node
#
# Source is never baked in — /app/src is provided by a shared read-only
# bind mount at runtime (see src/container-runner.ts). Source-only changes
# never require an image rebuild.

FROM node:22-slim

# ---- Build-time arguments ----------------------------------------------------
# CJK fonts add ~200MB. Opt in only if you render Chinese/Japanese/Korean text.
ARG INSTALL_CJK_FONTS=false

# Pin CLI versions for reproducibility. Bump deliberately — unpinned installs
# mean every rebuild silently picks up the latest and can break in lockstep
# across all users.
ARG CLAUDE_CODE_VERSION=2.1.128
ARG BUN_VERSION=1.3.12

# ---- System dependencies -----------------------------------------------------
# tini: correct PID 1 / signal forwarding so outbound.db writes finalize on
# SIGTERM instead of being orphaned by the shell entrypoint.
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    --mount=type=cache,target=/var/lib/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
        ca-certificates \
        curl \
        git \
        python3 \
        python3-crcmod \
        tini \
        unzip \
    && rm -rf /var/lib/apt/lists/*

# ---- Bun runtime -------------------------------------------------------------
# Install via the official script (handles multi-arch detection), then move
# the binary to /usr/local/bin so the non-root `node` user can execute it.
RUN curl -fsSL https://bun.sh/install | bash -s "bun-v${BUN_VERSION}" && \
    install -m 0755 /root/.bun/bin/bun /usr/local/bin/bun && \
    rm -rf /root/.bun

# ---- agent-runner deps -------------------------------------------------------
# Deps are cached independently of CLI versions. Source is NOT baked in —
# it's provided by the shared RO mount at runtime.
WORKDIR /app

COPY agent-runner/package.json agent-runner/bun.lock ./

# Drop the musl-linked claude binary after install — this is a Debian (glibc)
# image, so the musl variant (~213MB) can never run; the glibc one stays.
# Removed in the same layer so it never lands in the committed image.
RUN --mount=type=cache,target=/root/.bun/install/cache \
    bun install --frozen-lockfile && \
    rm -rf node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl

# ---- pnpm + global Node CLIs -------------------------------------------------
# Most stable first, most frequently bumped last. Bumping claude-code
# (the most common change) only invalidates one layer.
#
# only-built-dependencies gates pnpm's supply-chain policy:
#   - agent-browser has a postinstall build step.
#   - @anthropic-ai/claude-code's postinstall downloads the native Claude
#     binary (linux-arm64 variant on our image). Without the allowlist
#     the SDK fails at spawn time with "native binary not found".
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
# Pin pnpm to match the host (package.json packageManager). pnpm 11 stopped
# honoring `only-built-dependencies[]=` in .npmrc for global installs, which
# silently skips claude-code's native-binary postinstall and agent-browser's
# bin chmod — the agent then crashes at runtime with "native binary not
# installed". Keep this in lockstep with package.json's `packageManager`.
ARG PNPM_VERSION=10.33.0
RUN corepack enable && corepack prepare pnpm@${PNPM_VERSION} --activate

RUN --mount=type=cache,target=/root/.cache/pnpm \
    echo "only-built-dependencies[]=@anthropic-ai/claude-code" > /root/.npmrc && \
    pnpm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# ---- ncl CLI wrapper ----------------------------------------------------------
# Actual script lives in the mounted source at /app/src/cli/ncl.ts.
RUN printf '#!/bin/sh\nexec bun /app/src/cli/ncl.ts "$@"\n' > /usr/local/bin/ncl && \
    chmod +x /usr/local/bin/ncl

# ---- Entrypoint --------------------------------------------------------------
COPY entrypoint.sh /app/entrypoint.sh
RUN chmod +x /app/entrypoint.sh

# ---- Workspace + permissions -------------------------------------------------
RUN mkdir -p /workspace/group /workspace/extra && \
    chown -R node:node /workspace && \
    chmod 777 /home/node

# Trust bind-mounted repos. They appear under a different owner inside the
# container (uid remap), which git rejects as "dubious ownership", breaking
# git operations on mounted code. Containers are ephemeral and only mount host
# paths the operator explicitly allowlists, so trusting all repos is safe here.
RUN git config --system --add safe.directory '*'

# GitHub CLI — used by the agent to open draft PRs (`gh pr create --draft`).
# gh reads GITHUB_TOKEN from the env at runtime for auth. Arch-detected,
# pinned to the latest release at build time.
RUN ARCH=$(dpkg --print-architecture) && \
    GH_VER=$(curl -fsSL https://api.github.com/repos/cli/cli/releases/latest | grep '"tag_name"' | head -1 | sed -E 's/.*"v?([0-9.]+)".*/\1/') && \
    curl -fsSL "https://github.com/cli/cli/releases/download/v${GH_VER}/gh_${GH_VER}_linux_${ARCH}.tar.gz" | tar -xz -C /tmp && \
    install "/tmp/gh_${GH_VER}_linux_${ARCH}/bin/gh" /usr/local/bin/gh && \
    rm -rf "/tmp/gh_${GH_VER}_linux_${ARCH}" && \
    gh --version

# Git push auth: supply the token from the GITHUB_TOKEN env var at push time
# via a credential helper. Keeps the token out of .git/config and remote URLs.
RUN git config --system credential.helper '!f() { echo "username=x-access-token"; echo "password=$GITHUB_TOKEN"; }; f'

# gcloud CLI — used by the agent to query Cloud Run, logs, etc. on
# vatedge-prod (via impersonation from staging SA) and vatedge-staging.
# Pin to a known-good release. Install only what's needed (no anthos / kubectl
# / app-engine) to keep image size down (~120MB added).
ARG GCLOUD_VERSION=506.0.0
RUN ARCH=$(dpkg --print-architecture) && \
    case "$ARCH" in \
      amd64) GARCH=x86_64 ;; \
      arm64) GARCH=arm ;; \
      *) echo "unsupported arch $ARCH"; exit 1 ;; \
    esac && \
    curl -fsSL "https://dl.google.com/dl/cloudsdk/channels/rapid/downloads/google-cloud-cli-${GCLOUD_VERSION}-linux-${GARCH}.tar.gz" -o /tmp/gcloud.tgz && \
    tar -xzf /tmp/gcloud.tgz -C /opt && \
    /opt/google-cloud-sdk/install.sh --quiet --usage-reporting=false --command-completion=false --path-update=false && \
    ln -s /opt/google-cloud-sdk/bin/gcloud /usr/local/bin/gcloud && \
    ln -s /opt/google-cloud-sdk/bin/gsutil /usr/local/bin/gsutil && \
    rm -f /tmp/gcloud.tgz && \
    gcloud --version | head -3

USER node
WORKDIR /workspace/group

# tini is PID 1, reaps zombies, forwards signals cleanly. entrypoint.sh does
# `exec bun ...` so bun runs as tini's direct child.
ENTRYPOINT ["/usr/bin/tini", "--", "/app/entrypoint.sh"]

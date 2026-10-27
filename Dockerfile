# syntax=docker/dockerfile:1.7

# ================= Stage 1: deps =================
FROM node:22-alpine AS deps

WORKDIR /app

ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable

COPY package.json pnpm-lock.yaml* ./

# Slim image (default): install production deps.
# playwright is optional; pnpm skips it when the platform lacks the binary
# unless the user forces it via INSTALL_PLAYWRIGHT build-arg.
# --ignore-scripts: without it pnpm still runs the project's own lifecycle
# scripts, and "prepare": "husky" fails here because husky is a devDependency
# and --prod skipped it. No runtime dependency needs a build step.
ARG INSTALL_PLAYWRIGHT=0

RUN \
  if [ "$INSTALL_PLAYWRIGHT" = "1" ]; then \
    pnpm install --prod --frozen-lockfile --ignore-scripts; \
  else \
    pnpm install --prod --frozen-lockfile --no-optional --ignore-scripts; \
  fi

# ================= Stage 2: slim runtime =================
FROM node:22-alpine AS runtime-slim

# Injected by CI as --build-arg (commit SHA / branch-or-tag).
ARG VCS_REFERENCE
ARG BUILD_VERSION_REFERENCE

ENV NODE_ENV=production
ENV TV_OUTPUT_DIR=/data
ENV APPLICATION_VCS_REFERENCE=${VCS_REFERENCE}
ENV APPLICATION_BUILD_VERSION=${BUILD_VERSION_REFERENCE}

WORKDIR /app

RUN \
  addgroup -S -g 1000 app && \
  adduser -S -u 1000 -G app -h /app -s /sbin/nologin app && \
  mkdir -p /data && \
  chown -R app:app /app /data

COPY --from=deps --chown=app:app /app/node_modules ./node_modules
COPY --chown=app:app bin ./bin
COPY --chown=app:app src ./src
COPY --chown=app:app package.json ./package.json

VOLUME ["/data"]

USER app

ENTRYPOINT ["node", "bin/scrape.js"]
CMD ["--help"]

# ================= Stage 3: with-browser runtime (opt-in) =================
# Tag must match the playwright version resolved in pnpm-lock.yaml (1.64.1),
# otherwise the baked browser builds do not match what playwright-core expects.
# This tag ships Node 24, which satisfies engines.node >= 22.13.0.
FROM mcr.microsoft.com/playwright:v1.64.1-jammy AS runtime-with-browser

# Injected by CI as --build-arg (commit SHA / branch-or-tag).
ARG VCS_REFERENCE
ARG BUILD_VERSION_REFERENCE

ENV NODE_ENV=production
ENV TV_OUTPUT_DIR=/data
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV APPLICATION_VCS_REFERENCE=${VCS_REFERENCE}
ENV APPLICATION_BUILD_VERSION=${BUILD_VERSION_REFERENCE}

WORKDIR /app

# The base image already ships "pwuser" with uid/gid 1000 (it runs
# "adduser pwuser" over ubuntu:jammy), so reuse it rather than creating another
# account. The uid/gid is what the /data bind mount depends on, and it matches
# the slim stage's "app" user — only the name differs.
RUN \
  mkdir -p /data && \
  chown -R pwuser:pwuser /app /data

COPY --from=deps --chown=pwuser:pwuser /app/node_modules ./node_modules
COPY --chown=pwuser:pwuser bin ./bin
COPY --chown=pwuser:pwuser src ./src
COPY --chown=pwuser:pwuser package.json ./package.json

VOLUME ["/data"]

USER pwuser

ENTRYPOINT ["node", "bin/scrape.js"]
CMD ["--help"]

# Final target selection: build-arg INSTALL_PLAYWRIGHT=1 → runtime-with-browser
ARG INSTALL_PLAYWRIGHT=0
FROM runtime-slim AS final
FROM runtime-with-browser AS final-browser
ARG INSTALL_PLAYWRIGHT=0
# dockerfile 1.7 multi-stage with conditional:
# Users get runtime-slim unless they pass --target final-browser.

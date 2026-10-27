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
ARG INSTALL_PLAYWRIGHT=0

RUN \
  if [ "$INSTALL_PLAYWRIGHT" = "1" ]; then \
    pnpm install --prod --frozen-lockfile; \
  else \
    pnpm install --prod --frozen-lockfile --no-optional; \
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
FROM mcr.microsoft.com/playwright:v1.45.0-jammy AS runtime-with-browser

# Injected by CI as --build-arg (commit SHA / branch-or-tag).
ARG VCS_REFERENCE
ARG BUILD_VERSION_REFERENCE

ENV NODE_ENV=production
ENV TV_OUTPUT_DIR=/data
ENV PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
ENV APPLICATION_VCS_REFERENCE=${VCS_REFERENCE}
ENV APPLICATION_BUILD_VERSION=${BUILD_VERSION_REFERENCE}

WORKDIR /app

RUN \
  groupadd -g 1000 app && \
  useradd -u 1000 -g app -m -s /usr/sbin/nologin app && \
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

# Final target selection: build-arg INSTALL_PLAYWRIGHT=1 → runtime-with-browser
ARG INSTALL_PLAYWRIGHT=0
FROM runtime-slim AS final
FROM runtime-with-browser AS final-browser
ARG INSTALL_PLAYWRIGHT=0
# dockerfile 1.7 multi-stage with conditional:
# Users get runtime-slim unless they pass --target final-browser.

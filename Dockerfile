# ---- Stage 1: resolve the build's git commit ----
# Only this stage ever sees .git (needed to read the current commit) — the
# runtime stage below copies its filesystem from here *after* .git is
# deleted, so .git itself never lands in any layer that actually ships.
# Works automatically for both a local `docker compose build` and
# Portainer's Git-repository stacks (which clone the real repo, .git
# included) — no env var or command-line flag to remember either way.
# Building from a source with no .git (e.g. GitHub's "Download ZIP") just
# yields "unknown" here, same as any other build-info-unavailable case.
FROM node:20-alpine AS build
WORKDIR /app
COPY . .
RUN apk add --no-cache git \
    && (git rev-parse --short HEAD > .build-commit 2>/dev/null || echo unknown > .build-commit) \
    && rm -rf .git

FROM node:20-alpine

# su-exec drops from root to the `app` user in the entrypoint, after fixing
# up permissions on the (possibly host-bind-mounted) data/uploads dirs.
RUN apk add --no-cache su-exec

WORKDIR /app

# Install dependencies first so this layer is cached unless package*.json changes
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

# Pulls in the rest of the source (and .build-commit) from the build stage
# above, whose .git is already gone — this never touches node_modules just
# installed above, since the build stage has no node_modules of its own for
# this copy to overwrite.
COPY --from=build /app /app

# Persisted data lives here — mounted as volumes in docker-compose.yml
RUN mkdir -p /app/data /app/uploads/products /app/uploads/po-attachments

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
RUN chmod +x /app/docker-entrypoint.sh

# Stays root here — a bind-mounted ./data or ./uploads from the host may not
# exist yet or may be owned by root (Docker auto-creates it that way), so the
# entrypoint chowns them before dropping privileges to `app` to run node.
ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://localhost:3001/ || exit 1

ENTRYPOINT ["/app/docker-entrypoint.sh"]
CMD ["node", "server.js"]

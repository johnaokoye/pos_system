FROM node:20-alpine

# su-exec drops from root to the `app` user in the entrypoint, after fixing
# up permissions on the (possibly host-bind-mounted) data/uploads dirs.
RUN apk add --no-cache su-exec

WORKDIR /app

# Install dependencies first so this layer is cached unless package*.json changes
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

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

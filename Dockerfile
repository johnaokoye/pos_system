FROM node:20-alpine

WORKDIR /app

# Install dependencies first so this layer is cached unless package*.json changes
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Persisted data lives here — mounted as volumes in docker-compose.yml
RUN mkdir -p /app/data /app/uploads/products /app/uploads/po-attachments

RUN addgroup -S app && adduser -S app -G app && chown -R app:app /app
USER app

ENV NODE_ENV=production
ENV PORT=3001
EXPOSE 3001

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD wget -q -O- http://localhost:3001/ || exit 1

CMD ["node", "server.js"]

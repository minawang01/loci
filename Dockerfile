FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# rclone mirrors the data directory to cloud storage; see lib/backup.js.
RUN apt-get update \
  && apt-get install -y --no-install-recommends rclone ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Overridden by the host if it injects its own PORT.
ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000
CMD ["node", "server.js"]

FROM node:22-slim AS build

WORKDIR /app

# better-sqlite3 has no prebuilt binary for every Node version/arch combo, so
# npm falls back to compiling it from source via node-gyp, which needs all
# three of python3/make/g++. Build-only — none of this ships in the final image.
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

# rclone mirrors the data directory to cloud storage; see lib/backup.js.
RUN apt-get update \
  && apt-get install -y --no-install-recommends rclone ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY --from=build /app/node_modules ./node_modules
COPY . .

# Overridden by the host if it injects its own PORT.
ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000
CMD ["node", "server.js"]

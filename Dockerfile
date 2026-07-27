FROM node:22-slim

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY . .

# Overridden by the host if it injects its own PORT.
ENV PORT=3000
ENV DATA_DIR=/data

EXPOSE 3000
CMD ["node", "server.js"]

FROM oven/bun:1.3.9-alpine AS build

WORKDIR /app

COPY package.json bun.lock tsconfig.redirect.json ./
COPY railway-redirect/server.ts ./railway-redirect/server.ts
RUN bun install --frozen-lockfile && bun run build:redirect

FROM oven/bun:1.3.9-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build --chown=bun:bun /app/dist/railway-redirect/server.js ./server.js

USER bun

EXPOSE 8080

CMD ["bun", "server.js"]

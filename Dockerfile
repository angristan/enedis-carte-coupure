FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.redirect.json ./
COPY railway-redirect/server.ts ./railway-redirect/server.ts
RUN npm ci && npm run build:redirect

FROM node:22-alpine

WORKDIR /app

ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/dist/railway-redirect/server.js ./server.js

USER node

EXPOSE 8080

CMD ["node", "server.js"]

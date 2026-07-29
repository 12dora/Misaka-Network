FROM node:20-alpine AS deps
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM deps AS build
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:20-alpine AS prod-deps
WORKDIR /app
COPY package*.json ./
RUN npm ci --omit=dev

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
COPY --from=prod-deps /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY package.json ./
# TURN auto-provisioning persists state (monthly bytes, deny list, active
# credentials) into /app/data. Mount a host volume in production so kill-switch
# / bans survive restarts. Run as the non-root `node` user (uid 1000 in the
# official image) so a container breakout does not start as root.
RUN mkdir -p /app/data && chown -R node:node /app
VOLUME ["/app/data"]
USER node
# Must match the runtime default in src/config.ts (PORT=9080) and the port
# published by docker-compose.yml / deploy/docker-compose.prod.yml.
EXPOSE 9080
# Same entry point as `npm run dev` and `npm start` (see src/bootstrap.ts):
# it loads /app/.env when one is mounted, and otherwise just runs on the
# process environment injected by Compose.
CMD ["node", "dist/bootstrap.js"]

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
# / bans survive restarts. Default permissions are fine for the node user.
RUN mkdir -p /app/data
VOLUME ["/app/data"]
EXPOSE 8080
CMD ["node", "dist/index.js"]

# Build context is the repository root:  docker build -f backend/Dockerfile --target <api|edge> .
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci -w backend --include-workspace-root=false

FROM deps AS build
COPY backend backend
RUN npm run build -w backend

FROM node:22-alpine AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY backend/package.json backend/
COPY frontend/package.json frontend/
RUN npm ci -w backend --omit=dev --include-workspace-root=false

# ---- Express only (used behind the separate nginx container in docker compose)
FROM node:22-alpine AS api
ENV NODE_ENV=production
WORKDIR /app/backend
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=build /app/backend/dist ./dist
COPY backend/package.json ./
USER node
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s CMD wget -qO- http://127.0.0.1:3000/health/live || exit 1
CMD ["node", "dist/server.js"]

# ---- Nginx + Express in one container (Render free web service)
FROM node:22-alpine AS edge
ENV NODE_ENV=production
RUN apk add --no-cache nginx gettext
WORKDIR /app/backend
COPY --from=prod-deps /app/node_modules /app/node_modules
COPY --from=build /app/backend/dist ./dist
COPY backend/package.json ./
COPY deploy/nginx/default.conf.template /etc/nginx/templates/default.conf.template
COPY deploy/docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /run/nginx
# nginx master needs root to bind and write its pid/log paths; Express runs in the same process group.
EXPOSE 10000
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s CMD wget -qO- http://127.0.0.1:${PORT:-10000}/nginx-health || exit 1
ENTRYPOINT ["/usr/local/bin/docker-entrypoint.sh"]

# syntax=docker/dockerfile:1

FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
COPY . .
RUN npm run build

FROM node:24-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --omit=dev --workspace server --include-workspace-root=false

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production \
    PORT=8080 \
    KERNEL_WEB_DIST=/app/web/dist
COPY --from=deps /app/node_modules node_modules
COPY server/package.json server/
COPY server/migrations server/migrations
COPY --from=build /app/server/dist server/dist
COPY --from=build /app/web/dist web/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s \
  CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
# telemetry.js starts OpenTelemetry only when OTEL_EXPORTER_OTLP_ENDPOINT is set.
CMD ["node", "--import", "./server/dist/telemetry.js", "server/dist/index.js"]

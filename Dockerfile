# syntax=docker/dockerfile:1

# The base image is pinned by digest (#66); Dependabot proposes updates.

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --ignore-scripts
COPY . .
RUN npm run build

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci --ignore-scripts --omit=dev --workspace server --include-workspace-root=false

FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4
# Kernel runs with node alone: removing npm, npx and corepack drops their bundled dependencies from the image.
RUN rm -rf /usr/local/lib/node_modules /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack /opt/yarn* /usr/local/bin/yarn /usr/local/bin/yarnpkg
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

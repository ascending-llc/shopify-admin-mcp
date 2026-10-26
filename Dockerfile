# syntax=docker/dockerfile:1

# ── Build stage ───────────────────────────────────────────────────────
FROM node:20-bullseye AS build
WORKDIR /app

# Install all deps (incl. dev) and compile to dist/. `npm install` (not `npm ci`)
# resolves the platform's native optional deps directly, avoiding cross-platform
# lockfile gaps (a macOS-generated lockfile omits linux-only @emnapi/* deps).
COPY package.json package-lock.json ./
RUN npm install
COPY tsconfig.json ./
COPY src ./src
RUN npm run build
# Drop devDependencies so node_modules can be copied as the prod runtime tree.
RUN npm prune --omit=dev

# ── Runtime stage ─────────────────────────────────────────────────────
FROM node:20-slim AS runtime
WORKDIR /app

ENV NODE_ENV=production \
    SHOPIFY_MCP_TRANSPORT=http \
    SHOPIFY_MCP_MODE=read

# Non-root runtime user.
RUN groupadd -r app && useradd -r -g app -d /app app

# Production node_modules (resolved + pruned on linux) + compiled output.
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
RUN chown -R app:app /app

USER app
EXPOSE 3334

# Liveness parity for `docker run`; orchestrators should probe GET /healthz.
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://localhost:3334/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

# Credentials are NOT baked in. Under Jarvis the bearer + shop arrive per request
# (D12/D15); mode is env-driven so one image serves both read and full.
CMD ["node", "dist/index.js"]

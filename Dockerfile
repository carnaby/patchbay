# syntax=docker/dockerfile:1.7
# Patchbay: one image, one process. Mount a volume at /data - it holds the
# dashboard folders and the SQLite index.

FROM node:24-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/core/package.json packages/core/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile
COPY . .
RUN pnpm --filter @patchbay/web build
# Reinstall with production dependencies of the server only.
RUN rm -rf node_modules apps/*/node_modules packages/*/node_modules \
  && pnpm install --frozen-lockfile --prod --filter "@patchbay/server..."

FROM base AS runtime
# The source label links a GHCR package to this repository, so it shows the README and repo access applies.
LABEL org.opencontainers.image.source="https://github.com/carnaby/patchbay" \
      org.opencontainers.image.description="Live dashboards your AI can build." \
      org.opencontainers.image.licenses="MIT"
# tini for clean signal handling. No font packages: the PNG renderer ships its own (apps/server/src/render/fonts).
RUN apt-get update && apt-get install -y --no-install-recommends tini \
  && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data
COPY --from=build /app/package.json /app/pnpm-workspace.yaml ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/core ./packages/core
COPY --from=build /app/apps/server ./apps/server
COPY --from=build /app/apps/web/dist ./apps/web/dist
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=5s CMD node -e "fetch('http://127.0.0.1:8787/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["tini", "--"]
# --expose-gc: the snapshot renderer collects after each render to release resvg's native memory (render/gc.ts).
CMD ["node", "--expose-gc", "apps/server/src/main.ts"]

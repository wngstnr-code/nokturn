# Built from the repo root, docker build -f indexer/Dockerfile .
# Chain records are read from infra/, which docker-compose.yml mounts read only.

FROM node:24-alpine AS deps
WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json api/
COPY solver/package.json solver/
COPY indexer/package.json indexer/
COPY analytics/package.json analytics/
COPY infra/package.json infra/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod --filter ./indexer --filter ./packages/shared

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app /app
COPY packages/shared packages/shared
COPY indexer/src indexer/src
COPY indexer/sql indexer/sql
USER node
# The checkpoint moves on every step, one step a block.
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 \
  CMD node indexer/src/healthcheck.ts
CMD ["node", "indexer/src/index.ts"]

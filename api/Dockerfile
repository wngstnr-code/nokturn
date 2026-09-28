# Built from the repo root, docker build -f api/Dockerfile .
# The API imports the receipt builder and the database client from indexer/src,
# so indexer's runtime dependencies come along. Chain records are not baked in.
# docker-compose.yml mounts infra/ read only, where make up's deploy wrote them.

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
RUN pnpm install --frozen-lockfile --prod --filter ./api --filter ./indexer --filter ./packages/shared

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production NOKTURN_API_HOST=0.0.0.0
COPY --from=deps /app /app
COPY packages/shared packages/shared
COPY indexer/src indexer/src
COPY indexer/sql indexer/sql
COPY api/src api/src
USER node
WORKDIR /app/api
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=12 \
  CMD wget -qO- http://127.0.0.1:3000/v1/health > /dev/null || exit 1
CMD ["node", "src/index.ts"]

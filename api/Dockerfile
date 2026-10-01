# Built from the repo root, docker build -f api/Dockerfile .
# The API imports the receipt builder and the database client from indexer/src,
# so indexer's runtime dependencies come along. The mainnet record is baked in.
# docker-compose.yml mounts infra/ read only over it, where make up's deploy
# wrote the fork record.

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
# viem lists typescript as an optional peer, and the lockfile resolves it, so a
# production install still brings it. Nothing imports it at run time.
RUN rm -rf node_modules/.pnpm/typescript@*

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production NOKTURN_API_HOST=0.0.0.0
COPY --from=deps /app /app
COPY packages/shared packages/shared
COPY indexer/src indexer/src
COPY indexer/sql indexer/sql
# The mainnet record and the token list, for a host like Railway with no mounts.
# Under compose ./ is mounted over /app/infra and the fork record wins. The
# token list is generated from Addresses.sol the way make does it, since the
# generated file is not committed.
COPY contracts/deployments/4663.json contracts/deployments/4663.json
COPY contracts/script/Addresses.sol /tmp/Addresses.sol
COPY infra/scripts/extract-addresses.mjs /tmp/extract-addresses.mjs
RUN mkdir -p infra && node /tmp/extract-addresses.mjs /tmp/Addresses.sol infra/chain.json && rm /tmp/Addresses.sol /tmp/extract-addresses.mjs
COPY api/src api/src
COPY data/backtest data/backtest
USER node
WORKDIR /app/api
EXPOSE 3000
HEALTHCHECK --interval=5s --timeout=3s --start-period=20s --retries=12 \
  CMD wget -qO- "http://127.0.0.1:${NOKTURN_API_PORT:-3000}/v1/health" > /dev/null || exit 1
CMD ["node", "src/index.ts"]

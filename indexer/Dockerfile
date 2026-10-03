# Built from the repo root, docker build -f indexer/Dockerfile .
# The mainnet record is baked in. Under compose the fork record is read from
# infra/, which docker-compose.yml mounts read only.

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
# viem lists typescript as an optional peer, and the lockfile resolves it, so a
# production install still brings it. Nothing imports it at run time.
RUN rm -rf node_modules/.pnpm/typescript@*

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app /app
COPY packages/shared packages/shared
COPY indexer/src indexer/src
COPY indexer/sql indexer/sql
# The mainnet record and the token list, for a host like Railway with no mounts.
# Under compose ./ is mounted over /app/infra and the fork record wins. The
# token list is generated from Addresses.sol the way make does it, since the
# generated file is not committed. The testnet record comes too, so one image
# serves whichever chain NOKTURN_INDEXER_RPC answers as.
COPY contracts/deployments/4663.json contracts/deployments/4663.json
COPY contracts/deployments/46630.json contracts/deployments/46630.json
COPY contracts/script/Addresses.sol /tmp/Addresses.sol
COPY infra/scripts/extract-addresses.mjs /tmp/extract-addresses.mjs
RUN mkdir -p infra && node /tmp/extract-addresses.mjs /tmp/Addresses.sol infra/chain.json && rm /tmp/Addresses.sol /tmp/extract-addresses.mjs
USER node
# The checkpoint moves on every step, one step a block.
HEALTHCHECK --interval=10s --timeout=5s --start-period=60s --retries=6 \
  CMD node indexer/src/healthcheck.ts
CMD ["node", "indexer/src/index.ts"]

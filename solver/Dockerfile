# Built from the repo root, docker build -f solver/Dockerfile .
# One image for the solver and the auction keeper on any chain. Which chain is
# whatever NOKTURN_SOLVER_RPC answers as, and the record for it is baked in.
#
# NOKTURN_ROLE picks solver (the default), keeper, or both in one container.
# solver/entrypoint.sh has the details.
#
# Keys come from NOKTURN_SOLVER_PRIVATE_KEY and NOKTURN_SOLVER_B_PRIVATE_KEY,
# set per Railway environment, so a testnet service never sees a mainnet key.

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
RUN pnpm install --frozen-lockfile --prod --filter ./solver --filter ./packages/shared
# viem lists typescript as an optional peer, and the lockfile resolves it, so a
# production install still brings it. Nothing imports it at run time.
RUN rm -rf node_modules/.pnpm/typescript@*

FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app /app
COPY packages/shared packages/shared
COPY solver/src solver/src
COPY solver/entrypoint.sh solver/entrypoint.sh
COPY contracts/deployments/4663.json contracts/deployments/4663.json
COPY contracts/deployments/46630.json contracts/deployments/46630.json
COPY contracts/deployments/46630-fixtures.json contracts/deployments/46630-fixtures.json
# account.ts refuses any key of the public repo mnemonic, and reads the list here.
COPY infra/accounts.json infra/accounts.json
# The keeper's mainnet token list, generated the way the api image does it.
COPY contracts/script/Addresses.sol /tmp/Addresses.sol
COPY infra/scripts/extract-addresses.mjs /tmp/extract-addresses.mjs
RUN node /tmp/extract-addresses.mjs /tmp/Addresses.sol infra/chain.json && rm /tmp/Addresses.sol /tmp/extract-addresses.mjs
# The store of submitted solutions, so a restart finalizes what it submitted.
RUN mkdir -p solver/.state && chown node solver/.state
USER node
CMD ["sh", "solver/entrypoint.sh"]

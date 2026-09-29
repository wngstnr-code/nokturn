# Built from the repo root, docker build -f solver/Dockerfile .
# The profile, a or b, comes from the compose command. Chain records and the
# account list are read from infra/, which docker-compose.yml mounts read only.

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
# Profile b appends its own suffix to the store path, so the setting names a file
# inside /state rather than /state itself. Otherwise profile b writes /state-b,
# which is the image root and is not writable by node.
ENV NODE_ENV=production NOKTURN_SOLVER_STATE=/state/solver NOKTURN_SOLVER_HEARTBEAT=/tmp/solver-heartbeat
COPY --from=deps /app /app
COPY packages/shared packages/shared
COPY solver/src solver/src
RUN mkdir -p /state && chown node:node /state
USER node
# The heartbeat is rewritten on every batch the stream opens. The longest batch
# any session runs is 180 seconds, PROTECTIVE, so older than that is a stall.
HEALTHCHECK --interval=10s --timeout=3s --start-period=120s --retries=3 \
  CMD node -e "process.exit(Date.now() - require('fs').statSync(process.env.NOKTURN_SOLVER_HEARTBEAT).mtimeMs < 180000 ? 0 : 1)"
ENTRYPOINT ["node", "solver/src/index.ts", "--run"]

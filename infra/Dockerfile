# The tooling image, for the anvil and deploy services of docker-compose.yml.
# Built from the repo root, docker build -f infra/Dockerfile .
#
# It runs infra/scripts as they are, which need anvil, forge, cast and node
# together, so the fork and the deploy follow the same path make fork and make
# deploy take on a laptop. There is no second way to start the stack.
#
# The scripts, the contracts and the chain records come from the repo through
# bind mounts, see docker-compose.yml. Only infra's node dependencies and the
# Foundry binaries live in the image.

FROM node:24-bookworm-slim
ARG FOUNDRY_VERSION=v1.8.3
RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates curl git \
  && rm -rf /var/lib/apt/lists/*
RUN curl -fsSL "https://github.com/foundry-rs/foundry/releases/download/${FOUNDRY_VERSION}/foundry_${FOUNDRY_VERSION}_linux_amd64.tar.gz" \
  | tar -xz -C /usr/local/bin forge cast anvil \
  && forge --version

WORKDIR /app
RUN corepack enable
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY api/package.json api/
COPY solver/package.json solver/
COPY indexer/package.json indexer/
COPY analytics/package.json analytics/
COPY infra/package.json infra/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --prod --filter ./infra

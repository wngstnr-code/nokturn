# Built from the repo root, docker build -f infra/mirror/Dockerfile .
# contracts/tools/mirror.py, run unattended. It copies mainnet Chainlink rounds
# into the MirrorFeed contracts on 46630 and syncs the pools, parameter.md
# section 10.6. It shells out to cast, so Foundry comes along, pinned to the
# version the team builds with.

FROM python:3.12-slim
ARG FOUNDRY_VERSION=v1.7.1
RUN apt-get update \
  && apt-get install -y --no-install-recommends curl ca-certificates git \
  && rm -rf /var/lib/apt/lists/* \
  && useradd --create-home mirror
USER mirror
WORKDIR /home/mirror
RUN curl -fsSL https://foundry.paradigm.xyz | bash \
  && ~/.foundry/bin/foundryup --install "$FOUNDRY_VERSION" \
  && ~/.foundry/bin/cast --version
ENV PATH="/home/mirror/.foundry/bin:${PATH}" PYTHONUNBUFFERED=1
COPY --chown=mirror contracts/tools/mirror.py app/tools/mirror.py
COPY --chown=mirror contracts/deployments/46630-fixtures.json app/deployments/46630-fixtures.json
COPY --chown=mirror infra/mirror/entrypoint.sh app/entrypoint.sh
WORKDIR /home/mirror/app
CMD ["bash", "entrypoint.sh"]

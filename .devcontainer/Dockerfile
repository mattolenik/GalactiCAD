FROM node:25-bookworm-slim

RUN apt-get update && export DEBIAN_FRONTEND=noninteractive \
    && apt-get install -y --no-install-recommends bash jq make git \
    && rm -rf /var/lib/apt/lists/*

RUN rm -f /usr/local/bin/yarn /usr/local/bin/yarnpkg /usr/local/bin/pnpm /usr/local/bin/pnpx \
    && npm install -g corepack

COPY package.json /tmp/package.json

ENV COREPACK_ENABLE_DOWNLOAD_PROMPT=0
RUN corepack enable \
    && corepack prepare "$(jq -r .packageManager /tmp/package.json)" --activate \
    && rm /tmp/package.json

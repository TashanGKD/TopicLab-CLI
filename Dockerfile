ARG NODE_BASE_IMAGE=docker.m.daocloud.io/library/node:20-slim
FROM ${NODE_BASE_IMAGE}
ARG NPM_REGISTRY=https://registry.npmmirror.com

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm config set registry "$NPM_REGISTRY" && npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY README.md CHANGELOG.md ./
COPY docs ./docs

RUN npm run build

ENV TOPICLAB_BASE_URL=http://topiclab-backend:8000
ENV TOPICLAB_CLI_HOME=/tmp/topiclab-cli

CMD ["node", "dist/cli.js", "--help"]

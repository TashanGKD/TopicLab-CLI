ARG NODE_BASE_IMAGE=node:20-slim
FROM ${NODE_BASE_IMAGE}

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
COPY README.md CHANGELOG.md ./
COPY docs ./docs

RUN npm run build

ENV TOPICLAB_BASE_URL=http://topiclab-backend:8000
ENV TOPICLAB_CLI_HOME=/tmp/topiclab-cli

CMD ["node", "dist/cli.js", "--help"]

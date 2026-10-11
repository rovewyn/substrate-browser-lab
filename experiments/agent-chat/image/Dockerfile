FROM node:24.19.0-bookworm-slim@sha256:a9f5f7c91a432850b2a8a7797adf5eadb6c733ceed61167806cee7ea7fbc29df
ENV NODE_ENV=production HOME=/state/home CODEX_HOME=/state/codex AGENT_STATE=/state/chat
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates git ripgrep python3 curl && rm -rf /var/lib/apt/lists/*
COPY image/package.json image/package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY actor.mjs common.mjs launcher.mjs protocol-methods.json ./
COPY image/config.toml /app/config.toml
EXPOSE 80
CMD ["node", "/app/launcher.mjs"]

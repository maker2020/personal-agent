FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tini bash && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY profiles ./profiles
COPY tsconfig.json ./
RUN npm ci && npm run build && npm prune --omit=dev
ENV NODE_ENV=production
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/packages/gateway/src/main.js"]

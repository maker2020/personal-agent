# HEARTH_IMAGE_PREFIX is a registry prefix such as mirror.ccs.tencentyun.com/
# Empty keeps Docker Hub (library/node is the official name).
ARG HEARTH_IMAGE_PREFIX=
FROM ${HEARTH_IMAGE_PREFIX}library/node:22-bookworm-slim

ARG APT_MIRROR=
ARG NPM_REGISTRY=
ARG DOCKER_CLI_BASE=https://download.docker.com/linux/static/stable
ARG DOCKER_CLI_VERSION=27.5.1

RUN if [ -n "$APT_MIRROR" ]; then \
      mirror="${APT_MIRROR%/}"; \
      if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
        sed -i "s#http://deb.debian.org#${mirror}#g; s#https://deb.debian.org#${mirror}#g" /etc/apt/sources.list.d/debian.sources; \
      fi; \
      if [ -f /etc/apt/sources.list ]; then \
        sed -i "s#http://deb.debian.org#${mirror}#g; s#https://deb.debian.org#${mirror}#g" /etc/apt/sources.list; \
      fi; \
    fi \
 && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl tini bash \
 && rm -rf /var/lib/apt/lists/* \
 && arch="$(dpkg --print-architecture)" \
 && case "$arch" in amd64) darch=x86_64 ;; arm64) darch=aarch64 ;; *) echo "unsupported arch $arch" >&2; exit 1 ;; esac \
 && curl -fsSL "${DOCKER_CLI_BASE%/}/${darch}/docker-${DOCKER_CLI_VERSION}.tgz" -o /tmp/docker.tgz \
 && tar -xzf /tmp/docker.tgz -C /tmp docker/docker \
 && mv /tmp/docker/docker /usr/local/bin/docker \
 && chmod 755 /usr/local/bin/docker \
 && rm -rf /tmp/docker /tmp/docker.tgz \
 && docker --version

WORKDIR /app
COPY package.json package-lock.json ./
COPY packages ./packages
COPY profiles ./profiles
COPY tsconfig.json ./
# Empty keeps the default registry. install.sh --mirror cn sets https://registry.npmmirror.com.
RUN if [ -n "$NPM_REGISTRY" ]; then npm config set registry "$NPM_REGISTRY"; fi \
  && npm ci && npm run build && npm prune --omit=dev
ENV NODE_ENV=production
EXPOSE 8787
ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "dist/packages/gateway/src/main.js"]

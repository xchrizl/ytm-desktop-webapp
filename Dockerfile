# use the official Bun image
# see all versions at https://hub.docker.com/r/oven/bun/tags
FROM oven/bun:1 AS base
WORKDIR /usr/src/app

# install dependencies into temp directories
# separate stages so BuildKit can run the dev and prod installs in parallel,
# and so they cache independently
FROM base AS install-dev
RUN mkdir -p /temp/dev
COPY package.json bun.lock /temp/dev/
RUN cd /temp/dev && bun install --frozen-lockfile

# install with --production (exclude devDependencies)
FROM base AS install-prod
RUN mkdir -p /temp/prod
COPY package.json bun.lock /temp/prod/
RUN cd /temp/prod && bun install --frozen-lockfile --production

# copy node_modules from temp directory, then only the files the tests need --
# copying the whole context here would re-run the test layer on any change
# (README, compose files, ...), not just code changes
FROM base AS prerelease
COPY --from=install-dev /temp/dev/node_modules node_modules
COPY package.json bunfig.toml tsconfig.json ./
COPY src src
COPY public public
COPY tests tests

# tests set their own required env vars via bunfig.toml's preload
# (tests/setup.ts), so this needs no external config to run.
ENV NODE_ENV=production
RUN bun test

# copy production dependencies and source + static files into final image
FROM base AS release
COPY --from=install-prod /temp/prod/node_modules node_modules
COPY --from=prerelease /usr/src/app/src src
COPY --from=prerelease /usr/src/app/public public
COPY --from=prerelease /usr/src/app/package.json .

# pre-create the token persistence mount point owned by the "bun" user, so
# docker-compose's named volume inherits that ownership on first creation
# (Docker copies the image dir's contents/perms into a volume the first time
# it's mounted onto a non-empty path).
RUN mkdir -p /data && chown bun:bun /data

# run the app
USER bun
EXPOSE 8080/tcp
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
    CMD bun -e "fetch(\`http://localhost:\${process.env.SERVER_PORT ?? 8080}/\`).then(r => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"
ENTRYPOINT [ "bun", "run", "src/index.ts" ]

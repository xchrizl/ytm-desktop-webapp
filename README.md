# ytm-desktop-webapp

[![CI](https://github.com/xchrizl/ytm-desktop-webapp/actions/workflows/ci.yml/badge.svg)](https://github.com/xchrizl/ytm-desktop-webapp/actions/workflows/ci.yml)

To install dependencies:

```bash
bun install
```

Copy `.env.example` to `.env` and fill in `REMOTE_IP` (and any other values
you want to override — see the comments in `.env.example` for details):

```bash
cp .env.example .env
```

To type-check and run tests:

```bash
bun run typecheck
bun test
```

To run:

```bash
bun run .
```

## Docker

Build and push the image (needed before deploying via `docker-compose.yml` on
a host like TrueNAS, which runs images but doesn't build `Dockerfile`s):

```bash
docker login ghcr.io -u <your-github-username>
docker build -t ghcr.io/xchrizl/ytm-desktop-webapp:latest .
docker push ghcr.io/xchrizl/ytm-desktop-webapp:latest
```

`docker login ghcr.io` needs a GitHub personal access token (classic, scope
`write:packages`) as the password — generate one at
https://github.com/settings/tokens.

By default a pushed GHCR package is **private**; either make it public
(package settings → "Change visibility") or, on the deploying host, run
`docker login ghcr.io` with a token scoped `read:packages` before
`docker compose up -d`.

Then, on the deploying host:

```bash
docker compose up -d
```
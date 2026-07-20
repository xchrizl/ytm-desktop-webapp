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

### `docker-compose.truenas.yml`

An alternative, self-contained compose file for hosts like TrueNAS where
pasting a file into a GUI compose editor is easier than also managing a
separate `.env` file. All config lives inline under `environment:` instead of
via `env_file`, so it's a single file to copy/paste.

It also skips publishing a host port and instead joins an existing external
`traefik-net` network, so the app is reachable from a Traefik reverse proxy
container by its service name (`ytm-desktop-webapp:8080`) without exposing
the port on the host. This assumes `traefik-net` already exists (created by
Traefik's own compose stack) — adjust or remove the `networks:` section if
you don't use Traefik. It doesn't add Traefik routing labels
(`traefik.enable`, router rules, etc.) — wire those up separately depending
on how your Traefik instance discovers routes.

Before using it, edit the `REMOTE_IP` value to match the machine running YTM
Desktop.
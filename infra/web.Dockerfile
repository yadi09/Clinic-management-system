# syntax=docker/dockerfile:1
# Builds the React SPA and bakes it into a Caddy image that also reverse-proxies
# the API. Build context = repo root. Single edge for the whole app (ADR-001).

# ---- build SPA ----
FROM node:20-alpine AS build
WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci --no-audit --no-fund || npm install --no-audit --no-fund
COPY frontend/ ./
RUN npm run build

# ---- edge: Caddy serving SPA + proxying /api ----
FROM caddy:2-alpine
COPY infra/Caddyfile /etc/caddy/Caddyfile
COPY --from=build /app/dist /srv
EXPOSE 80 443

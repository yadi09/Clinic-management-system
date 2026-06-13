# syntax=docker/dockerfile:1

# ---- build ----
FROM golang:1.25-alpine AS build
WORKDIR /src
RUN apk add --no-cache git
COPY go.mod go.sum ./
RUN go mod download
COPY . .
ENV CGO_ENABLED=0 GOOS=linux
RUN go build -trimpath -ldflags="-s -w" -o /out/api ./cmd/api \
 && go build -trimpath -ldflags="-s -w" -o /out/worker ./cmd/worker \
 && go build -trimpath -ldflags="-s -w" -o /out/migrate ./cmd/migrate \
 && go build -trimpath -ldflags="-s -w" -o /out/seed ./cmd/seed

# ---- runtime (distroless, non-root, static) ----
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/ /app/
USER nonroot:nonroot
EXPOSE 8080
# Use CMD (not ENTRYPOINT) so the binary can be swapped per service: compose
# `command:` (e.g. ["/app/worker"], ["/app/migrate","up"]) and `docker compose
# run api /app/seed` REPLACE this default rather than being appended as args.
CMD ["/app/api"]

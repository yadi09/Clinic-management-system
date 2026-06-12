SHELL := /bin/bash
GOBIN := $(shell go env GOPATH)/bin
SQLC  := $(GOBIN)/sqlc

.PHONY: help tidy sqlc generate build vet test test-unit test-integration lint migrate-up migrate-down run-api run-worker seed

help:
	@grep -E '^[a-zA-Z_-]+:.*?## .*$$' $(MAKEFILE_LIST) | awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-18s\033[0m %s\n",$$1,$$2}'

tidy: ## go mod tidy
	go mod tidy

sqlc generate: ## regenerate typed repositories from SQL
	$(SQLC) generate

build: ## compile api + worker + migrate binaries
	go build -o ./bin/api ./cmd/api
	go build -o ./bin/worker ./cmd/worker
	go build -o ./bin/migrate ./cmd/migrate

vet: ## go vet
	go vet ./...

test: ## run all tests
	go test ./... -count=1

test-unit: ## run unit tests only (no DB)
	go test ./... -short -count=1

test-integration: ## run integration tests (requires DATABASE_URL to a test Postgres)
	go test ./... -run Integration -count=1

lint: ## run golangci-lint (install if missing)
	@command -v $(GOBIN)/golangci-lint >/dev/null || go install github.com/golangci/golangci-lint/cmd/golangci-lint@latest
	$(GOBIN)/golangci-lint run ./...

migrate-up: ## apply all migrations (uses DATABASE_URL)
	go run ./cmd/migrate up

migrate-down: ## roll back the last migration
	go run ./cmd/migrate down

run-api: ## run the API server
	go run ./cmd/api

run-worker: ## run the async worker (outbox relay + schedulers)
	go run ./cmd/worker

seed: ## seed one tenant + owner + system roles/permissions
	go run ./cmd/migrate up && go run ./cmd/seed

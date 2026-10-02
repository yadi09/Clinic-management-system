SHELL := /bin/bash
GOBIN := $(shell go env GOPATH)/bin
SQLC  := $(GOBIN)/sqlc

.PHONY: help tidy sqlc generate build vet test test-unit test-integration test-api test-regress test-tenancy test-auth test-patients test-appointments test-dental test-payments lint migrate-up migrate-down run-api run-worker seed

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

# Database tests need TEST_DATABASE_URL = a THROWAWAY Postgres (superuser). The suite
# refuses non-local hosts and databases without "test"/"regress" in the name.
# Known, catalogued bugs show as "KNOWN BUG <id>" skips; REGRESSION_STRICT=1 fails them.
REG := go test ./tests/regression/ -count=1 -v -run

test: ## everything: unit + integration + API regression (needs TEST_DATABASE_URL)
	go test ./... -count=1 -p 1

test-unit: ## unit tests only (no database, seconds)
	go test ./... -short -count=1

test-integration: ## all database-backed tests, incl. service-level dental money rules
	go test ./... -count=1 -p 1

test-api: ## black-box API regression suite (real API binary, RLS role)
	go test ./tests/regression/ -count=1 -v

test-regress: ## the full regression run with a readable summary (backend + frontend)
	../scripts/test/regress.sh

test-tenancy: ## clinic isolation only
	$(REG) 'REG_TENANT'
test-auth: ## authentication + authorization only
	$(REG) 'REG_AUTH'
test-patients: ## patients only
	$(REG) 'REG_PATIENT'
test-appointments: ## appointments, queue, reception only
	$(REG) 'REG_APPT'
test-dental: ## dental module (API) + dental service money rules
	$(REG) 'REG_DENTAL' && go test ./internal/dental/... -count=1
test-payments: ## payments, finance, dashboard money
	$(REG) 'REG_PAY|REG_FIN|REG_DASH'

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

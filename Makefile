PORT ?= 5177
GOCACHE ?= $(CURDIR)/.gocache
REDIS_ADDR ?= localhost:6379

.PHONY: run redis build frontend-build frontend-dev test fmt clean

run: frontend-build
	GOCACHE=$(GOCACHE) go run ./cmd/server -addr :$(PORT) -redis-addr $(REDIS_ADDR)

redis:
	redis-server --save "" --appendonly no --dir /tmp

build: frontend-build
	GOCACHE=$(GOCACHE) go build -o bin/enedis-carte-coupure ./cmd/server

frontend-build:
	npm run build

frontend-dev:
	npm run dev

test:
	GOCACHE=$(GOCACHE) go test ./...

fmt:
	gofmt -w ./cmd ./internal

clean:
	rm -rf bin .gocache

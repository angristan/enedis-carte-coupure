PORT ?= 5177
GOCACHE ?= $(CURDIR)/.gocache
REDIS_ADDR ?= localhost:6379

.PHONY: run redis build test fmt clean

run:
	GOCACHE=$(GOCACHE) go run ./cmd/server -addr :$(PORT) -redis-addr $(REDIS_ADDR)

redis:
	redis-server --save "" --appendonly no --dir /tmp

build:
	GOCACHE=$(GOCACHE) go build -o bin/enedis-carte-coupure ./cmd/server

test:
	GOCACHE=$(GOCACHE) go test ./...

fmt:
	gofmt -w ./cmd ./internal

clean:
	rm -rf bin .gocache

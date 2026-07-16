PORT ?= 5173

.PHONY: run dev build preview deploy test typecheck clean

run: dev

dev:
	bun run dev -- --host 127.0.0.1 --port $(PORT)

build:
	bun run build

preview:
	bun run preview -- --host 127.0.0.1 --port $(PORT)

deploy:
	bun run deploy

test:
	bun run test

typecheck:
	bun run typecheck

clean:
	rm -rf web .wrangler/state

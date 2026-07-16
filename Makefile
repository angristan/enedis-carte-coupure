PORT ?= 5173

.PHONY: run dev build preview deploy test clean

run: dev

dev:
	npm run dev -- --host 127.0.0.1 --port $(PORT)

build:
	npm run build

preview:
	npm run preview -- --host 127.0.0.1 --port $(PORT)

deploy:
	npm run deploy

test:
	npm run test

clean:
	rm -rf web .wrangler/state

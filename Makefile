.PHONY: install build typecheck lint test smoke smoke-live verify-dsh up down

install:
	npm ci

build:
	npm run build

typecheck:
	npm run typecheck

lint:
	npm run lint

test: build
	npm test

smoke: build
	npm run smoke

# End-to-end chat against the real DeepSeek API. Requires DEEPSEEK_API_KEY.
# Skips with exit 2 when the key is absent. Never prints the key.
smoke-live: build
	npm run smoke-live

verify-dsh: build
	npm run verify:dsh

up:
	docker compose up -d --build

down:
	docker compose down

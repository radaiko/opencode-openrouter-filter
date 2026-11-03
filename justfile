# Single entry for every gate. Agents run `just check` before claiming done.

install:
	npm install

test:
	npm run test

test-one file:
	npx vitest run {{file}}

lint:
	npm run lint

typecheck:
	npm run typecheck

build:
	npm run build

spec-lint:
	openspec validate --all --strict --no-interactive

check: lint typecheck test build spec-lint

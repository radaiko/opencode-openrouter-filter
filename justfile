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

# Filtering suite against the real embedded OpenCode host (offline, scratch XDG dirs).
e2e: build
	mkdir -p /tmp/opencode/e2e-xdg/config/opencode /tmp/opencode/e2e-xdg/data/opencode /tmp/opencode/e2e-xdg/state/opencode
	XDG_CONFIG_HOME=/tmp/opencode/e2e-xdg/config XDG_DATA_HOME=/tmp/opencode/e2e-xdg/data XDG_STATE_HOME=/tmp/opencode/e2e-xdg/state node test/e2e-filter.mjs

check: lint typecheck test build spec-lint e2e

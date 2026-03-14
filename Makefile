export TSX      ?= ./node_modules/.bin/tsx
export TSC      ?= ./node_modules/.bin/tsc
export RUN_FILE := .devserver.run
export LOG_FILE := .devserver.log
SHELL           := bash
BROWSER         ?= chromium
DIST            ?= dist
PORT            ?= $(shell $(BUILD) port)
BUILD           := $(TSX) --disable-warning=ExperimentalWarning build/build.mts

default: build test

.PHONY: open
open:
	$(BROWSER) http://localhost:$(PORT)

.PHONY: setup
setup:
	@mkdir -p $(DIST)
	pnpm install

.PHONY: build
build: check
	cp -af node_modules/monaco-editor/min/vs/editor $(DIST)/vs/
	$(BUILD) $(BUILD_FLAGS)

.PHONY: test
test: check
	$(TSX) --test

.PHONY: check
check: setup
	$(TSC) --noEmit

.PHONY: serve
serve: check
	$(BUILD) -w $(BUILD_FLAGS)

.PHONY: start
start:
	nohup $(BUILD) -w $(BUILD_FLAGS) > $(LOG_FILE) 2>&1 &
	@echo "View logs with: make logs"

logs:
	@tail -f $(LOG_FILE)

.PHONY: stop
stop:
	@if [ -f "$(RUN_FILE)" ]; then \
		pid=$$(jq -r .pid "$(RUN_FILE)"); \
		[ -n $$pid ] && kill -TERM $$pid; \
		rm -f "$(RUN_FILE)"; \
	fi

.PHONY: release
release: export PRODUCTION=1
release: build test

.PHONY: clean
clean: stop
	rm -rf $(DIST)
	rm -f .devserver.*

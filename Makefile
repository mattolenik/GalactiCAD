SHELL       := bash
BROWSER     ?= chromium
DIST        := dist
PORT        ?= $(shell $(BUILD) port)
export TSX  ?= ./node_modules/.bin/tsx
BUILD       := $(TSX) --disable-warning=ExperimentalWarning build/build.mts

default: build test


.PHONY: open
open:
	$(BROWSER) http://localhost:$(PORT)

.PHONY: setup
setup:
	pnpm install

.PHONY: build
build: check
	@mkdir -p $(DIST)
	rm -rf $(DIST)/vs && mkdir -p $(DIST)/vs/
	cp -af node_modules/monaco-editor/min/vs/editor $(DIST)/vs/
	$(BUILD) $(BUILD_FLAGS)

.PHONY: test
test:
	$(TSX) --test

.PHONY: check
check: setup
	./node_modules/.bin/tsc --noEmit

watch: BUILD_FLAGS=-w
watch: clean build
serve: watch

.PHONY: release
release: export PRODUCTION=1
release: build test

.PHONY: clean
clean:
	rm -rf $(DIST)

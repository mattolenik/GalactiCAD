SHELL       := bash
BROWSER     ?= chromium
DIST        := dist
PORT        ?= $(shell $(BUILD) port)
export TSX  ?= ./node_modules/.bin/tsx
BUILD       := $(TSX) --disable-warning=ExperimentalWarning build/build.mts
VERSION     := $(shell echo $$(ver=$$(git tag -l --points-at HEAD) && [[ -z $$ver ]] && ver=$$(git describe --always --dirty); printf $$ver))

default: build test

.PHONY: open
open:
	$(BROWSER) http://localhost:$(PORT)

.PHONY: build
build:
	@mkdir -p $(DIST)
	rm -rf $(DIST)/vs && mkdir -p $(DIST)/vs/base/
	cp -af node_modules/monaco-editor/min/vs/base/browser $(DIST)/vs/base/
	cp -af node_modules/monaco-editor/min/vs/editor $(DIST)/vs/
	$(BUILD) $(BUILD_FLAGS)

.PHONY: test
test:
	$(TSX) --test

watch: BUILD_FLAGS=-w
watch: clean build
serve: watch

.PHONY: release
release: export PRODUCTION=1
release: build test
	jq '.version="$(VERSION)"' <<< "$$(< package.json)" > package.json

.PHONY: clean
clean:
	rm -rf $(DIST)

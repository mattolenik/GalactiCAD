SHELL    := bash
BROWSER  ?= chromium
DIST     := dist
TSX      ?= npx tsx
PORT     ?= $(shell $(BUILD) port)
BUILD    := $(TSX) --disable-warning=ExperimentalWarning build/build.mts
VERSION  := $(shell echo $$(ver=$$(git tag -l --points-at HEAD) && [[ -z $$ver ]] && ver=$$(git describe --always --dirty); printf $$ver))

default: build test

.PHONY: open
open:
	$(BROWSER) http://localhost:$(PORT)

.PHONY: build
build:
	@mkdir -p $(DIST)
	$(BUILD) $(BUILD_FLAGS)

grammar: src/dsl/grammar.mts
src/dsl/grammar.mts: src/dsl/grammar.peg
	npx tspeg $? $@

.PHONY: test
test:
	$(TSX) --test

watch: BUILD_FLAGS=-w
watch: build
serve: watch

.PHONY: release
release: export PRODUCTION=1
release: build test
	jq '.version="$(VERSION)"' <<< "$$(< package.json)" > package.json

.PHONY: clean
clean:
	rm -rf $(DIST)

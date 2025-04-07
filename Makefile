SHELL    := bash
BROWSER  ?= chromium
DIST     := dist
TSX      ?= ./node_modules/.bin/tsx
PORT     ?= $(shell $(BUILD) port)
BUILD    := $(TSX) --disable-warning=ExperimentalWarning build/build.mts
VERSION  := $(shell echo $$(ver=$$(git tag -l --points-at HEAD) && [[ -z $$ver ]] && ver=$$(git describe --always --dirty); printf $$ver))

# exporting this enables rebuild, where the build is restarted entirely when changes to the build dir are detected
export REBUILD_STATUS := 100

default: build test

.PHONY: open
open:
	$(BROWSER) http://localhost:$(PORT)

.PHONY: build
build:
	@mkdir -p $(DIST)
	@(exit $(REBUILD_STATUS)); until (( $$? != $(REBUILD_STATUS) )); do \
		$(BUILD) $(BUILD_FLAGS); \
	done;

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

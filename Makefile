DIST    := dist
BUILD   := npx tsx --no-warnings build/build.mts
PORT    ?= $(shell $(BUILD) port)
BROWSER ?= chromium

default: build

.PHONY: open
open:
	$(BROWSER) http://localhost:$(PORT)

.PHONY: build
build:
	@mkdir -p $(DIST)
	$(BUILD) $(BUILD_FLAGS)

watch: BUILD_FLAGS=-w
watch: build
serve: watch

release:
	PRODUCTION=1 make build

.PHONY: clean
clean:
	rm -rf $(DIST)

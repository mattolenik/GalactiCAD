DIST     := dist
BUILD    := npx tsx --no-warnings build/build.mts
PORT     ?= $(shell $(BUILD) port)
BROWSER  ?= chromium
TEST_SRC := $(shell find src/ -type f -name '*_test.mts')

default: build test

.PHONY: open
open:
	$(BROWSER) http://localhost:$(PORT)

.PHONY: build
build:
	@mkdir -p $(DIST)
	@$(BUILD) $(BUILD_FLAGS)

test:
	npx tsx --test $(TEST_SRC)

watch: BUILD_FLAGS=-w
watch: build
serve: watch

release: test
	PRODUCTION=1 make build

.PHONY: clean
clean:
	rm -rf $(DIST)

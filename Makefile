DIST := dist

default: build

.PHONY: open
open:
	open http://localhost:8000/sdf.html

.PHONY: build
build:
	@mkdir -p $(DIST)
	npx tsx --no-warnings build/build.mts $(BUILD_FLAGS)

watch: BUILD_FLAGS=-w
watch: build
serve: watch

release:
	PRODUCTION=1 make build

.PHONY: clean
clean:
	rm -rf $(DIST)

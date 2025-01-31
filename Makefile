DIST := dist

default: build

serve: build
	cd $(DIST) && python3 -m http.server

.PHONY: open
open:
	open http://localhost:8000/sdf.html

.PHONY: build
build:
	@mkdir -p $(DIST)
	npx tsx --no-warnings build/build.mts $(BUILD_FLAGS)

watch: BUILD_FLAGS=-w
watch: build

release:
	PRODUCTION=1 make build

.PHONY: clean
clean:
	rm -rf $(DIST)

BUILD := build
DIST  := dist

HTML_SRC := sdf.html

default: build

serve: build
	cd $(DIST) && python3 -m http.server

open:
	open http://localhost:8000/sdf.html

_build_prep:
	@mkdir -p $(DIST)
	cp -f $(HTML_SRC) $(DIST)/

build: _build_prep
	npx tsx build/build.mts

watch: _build_prep
	npx tsx build/build.mts -w

release:
	PRODUCTION=1 make build

clean:
	rm -rf $(DIST)

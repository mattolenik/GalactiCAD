DIST := dist/

HTML_SRC := sdf.html

default: build

serve: build
	cd $(DIST) && python3 -m http.server

open:
	open http://localhost:8000/sdf.html

build:
	@mkdir -p $(DIST)
	cp -f $(HTML_SRC) $(DIST)
	npx tsx build.mts

release:
	PRODUCTION=1 make build

clean:
	rm -rf $(DIST)

DIST := dist/

default: build

serve: build
	cd $(DIST) && python3 -m http.server

open:
	open http://localhost:8000/sdf.html

build:
	@mkdir -p $(DIST)
	cp -f *.html $(DIST)
	npx tsx build.mts

clean:
	rm -rf $(DIST)

serve:
	npx esbuild sdf.ts --watch --outfile=sdf.js --servedir=.

open:
	open http://localhost:8000/sdf.html

dist/sdf.js: sdf.ts
	npx esbuild $^ --outfile=$@

dist/sdf.html: sdf.html
	cp -f $^ dist/

dist: dist/sdf.js dist/sdf.html

build: dist

serve:
	npx esbuild sdf.ts --watch --outfile=sdf.js

dist/sdf.ts: sdf.js
	npx esbuild sdf.ts --watch --outfile=sdf.js

dist/sdf.html: sdf.html
	cp -f $^ dist/

dist: dist/sdf.ts dist/sdf.html

build: dist

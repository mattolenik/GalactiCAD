# Renders the SFCC algorithm illustration video (docs/sfcc-meshing-algorithm.md).
# Uses the manim venv at docs/.venv-manim (see that dir for setup).

MANIM   := ../.venv-manim/bin/manim
SCRIPT  := sfcc_illustration.py
OUT     := sfcc-illustration.mp4

# Manim caches one partial movie file per animation and reuses unchanged ones
# on re-render. The cache-size cap is raised in manim.cfg (max_files_cached is
# a config-file-only option, not a CLI flag). Pass NOCACHE=1 to bypass the
# cache entirely (e.g. if you suspect a stale partial).
CACHE_FLAGS :=
ifeq ($(NOCACHE),1)
CACHE_FLAGS := --disable_caching
endif

.PHONY: all draft intro pngs clean $(OUT)

# Final render: 1080p @ 30fps, copied to $(OUT) next to the script.
all: pngs $(OUT)

$(OUT): $(SCRIPT) $(wildcard assets/*.png)
	$(MANIM) -qh --fps 30 $(CACHE_FLAGS) $(SCRIPT) SFCC
	cp media/videos/sfcc_illustration/1080p30/SFCC.mp4 $(OUT)

# Fast low-quality render of the full video (480p15) for iteration.
draft:
	$(MANIM) -ql $(CACHE_FLAGS) $(SCRIPT) SFCC

# Fast render of just the intro chapters (the IntroOnly dev scene).
intro:
	$(MANIM) -ql $(CACHE_FLAGS) $(SCRIPT) IntroOnly

# Regenerate every scene's SDF, solid mesh, and wireframe PNG, plus each crop.
# Run from the repo root: make -C docs/manim pngs
# Requires ImageMagick (magick) and the normal app/agent devserver dependencies.
# Keep renders sequential: the agent bridge serves one shared browser tab.
pngs: SHELL := /bin/bash
pngs:
	@command -v magick >/dev/null || { echo "ImageMagick (magick) is required" >&2; exit 1; }
	$(MAKE) -C ../.. build
	$(MAKE) -C ../.. start-agent
	@set -Eeuo pipefail; \
	cd ../..; \
	mkdir -p .agents/tmp; \
	stage=$$(mktemp -d "$$PWD/.agents/tmp/manim-pngs.XXXXXX"); \
	trap 'rm -rf -- "$$stage"' EXIT; \
	trap 'exit 130' INT; trap 'exit 143' TERM; \
	mkdir "$$stage/raw" "$$stage/assets"; \
	ready=false; \
	for attempt in {1..15}; do \
		if scripts/agentcli server refresh; then ready=true; break; fi; \
		sleep 2; \
	done; \
	[[ "$$ready" == true ]] || { echo "Agent browser bridge did not become ready" >&2; exit 1; }; \
	count=0; \
	for scene in docs/manim/scenes/*.yaml; do \
		test -f "$$scene"; \
		base=$${scene##*/}; base=$${base%.yaml}; \
		for variant in sdf solid wireframe; do \
			case "$$variant" in \
				sdf) suffix=; set -- --mode sdf ;; \
				solid) suffix=_mesh_solid; set -- --mode mesh --overlay wireframe=false ;; \
				wireframe) suffix=_mesh; set -- --mode mesh --overlay wireframe=true,theme=dark ;; \
			esac; \
			name="$$base$$suffix"; \
			scripts/agentcli render --yaml "$$scene" "$$@" --out "$$stage/raw/$$name.png"; \
			magick "$$stage/raw/$$name.png" -background black -alpha remove -alpha off "$$stage/assets/$$name.png"; \
			magick "$$stage/assets/$$name.png" -trim +repage -bordercolor black -border 60 "$$stage/assets/$${name}_crop.png"; \
			magick identify -regard-warnings "$$stage/assets/$$name.png" "$$stage/assets/$${name}_crop.png" >/dev/null; \
			count=$$((count + 2)); \
		done; \
	done; \
	mkdir -p docs/manim/assets; \
	cp "$$stage/assets/"*.png docs/manim/assets/; \
	printf 'Regenerated %s PNGs in docs/manim/assets\n' "$$count"

clean:
	rm -rf media __pycache__

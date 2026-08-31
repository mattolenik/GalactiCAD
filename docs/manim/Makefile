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

.PHONY: all draft intro clean

# Final render: 1080p @ 30fps, copied to $(OUT) next to the script.
all: $(OUT)

$(OUT): $(SCRIPT) $(wildcard assets/*.png)
	$(MANIM) -qh --fps 30 $(CACHE_FLAGS) $(SCRIPT) SFCC
	cp media/videos/sfcc_illustration/1080p30/SFCC.mp4 $(OUT)

# Fast low-quality render of the full video (480p15) for iteration.
draft:
	$(MANIM) -ql $(CACHE_FLAGS) $(SCRIPT) SFCC

# Fast render of just the intro chapters (the IntroOnly dev scene).
intro:
	$(MANIM) -ql $(CACHE_FLAGS) $(SCRIPT) IntroOnly

clean:
	rm -rf media __pycache__

MAKEFLAGS    += --no-print-directory
SHELL        := bash
# All generated output lives under ./dist:
#   dist/site     — web build (esbuild output, also what's deployed)
#   dist/build    — electron-builder buildResources (generated icons)
#   dist/release  — electron-builder packaged installers/archives
DIST_ROOT    ?= dist
DIST         ?= $(DIST_ROOT)/site
SED          := $(shell [[ $$(uname) == Darwin ]] && echo gsed || echo sed)
export TSX   ?= node_modules/.bin/tsx
export TSC   ?= node_modules/.bin/tsc
BUILD        := $(TSX) --disable-warning=ExperimentalWarning build/build.mts
BROWSERS_CLI := npx @puppeteer/browsers
BROWSERS_DIR := .browsers
VERSION      := $(shell scripts/version)

ifeq ($(AGENT),true)
export RUN_FILE := .devserver.agent.run
export LOG_FILE := .devserver.agent.log
else
export RUN_FILE := .devserver.run
export LOG_FILE := .devserver.log
endif

SHELL := bash
.ONESHELL:

default: setup build test

.PHONY: setup
setup:
	@mkdir -p $(DIST)
	pnpm install
	if ! $(BROWSERS_CLI) list --path $(BROWSERS_DIR) | grep -q chromium; then
		$(BROWSERS_CLI) install chromium@latest --path $(BROWSERS_DIR)
	fi

.PHONY: build
build: check
	$(BUILD) $(BUILD_FLAGS)

.PHONY: test
test: setup check
	$(TSX) --test

.PHONY: check
check:
	$(TSC) --noEmit

.PHONY: _start
_start:
	@if [[ -f "$(RUN_FILE)" ]]; then
		port=$$(jq -r .port "$(RUN_FILE)")
		pid=$$(jq -r .pid "$(RUN_FILE)")
		if kill -0 $$pid &> /dev/null; then
			echo "Server running at http://localhost:$$port"
			exit 0
		fi
	fi
	if [[ -z $$SKIP_SETUP ]]; then
		make setup
	fi
	# Port is chosen by build.mts from the project-folder suffix (base 6900/7900 + trailing
	# number), erroring out if taken. A PORT set in the environment passes through and overrides.
	nohup $(BUILD) -w $(BUILD_FLAGS) > $(LOG_FILE) 2>&1 &
	i=0
	while (( i < 60 )); do
		if [[ -f "$(RUN_FILE)" ]]; then
			port=$$(jq -r .port "$(RUN_FILE)")
			echo ""
			echo "Server running at http://localhost:$$port, logs at $(LOG_FILE)"
			exit 0
		fi
		sleep 0.5
		i=$$((i+1))
	done
	echo "Server never appeared at $(RUN_FILE)"
	exit 1

.PHONY: start-browser
start-browser:
	make _start AGENT=false

.PHONY: stop-browser
stop-browser:
	make _stop AGENT=false

.PHONY: start-agent
start-agent:
	make _start AGENT=true SKIP_SETUP=true

.PHONY: stop-agent
stop-agent:
	make _stop AGENT=true

.PHONY: start
start:
	make start-browser

.PHONY: _stop
_stop:
	@if [[ -f "$(RUN_FILE)" ]]; then
		pid=$$(jq -r .pid "$(RUN_FILE)")
		port=$$(jq -r .port "$(RUN_FILE)")
		if kill -0 $$pid &> /dev/null; then
			echo "Stopping server PID $$pid on port $$port"
			kill -TERM $$pid && rm -f "$(RUN_FILE)" || true
		else
			echo "WARNING: No server running with PID $$pid, stale run file"
		fi
	fi

.PHONY: stop
stop: stop-browser stop-agent

.PHONY: kill-agent-browsers
kill-agent-browsers: stop-agent
	jq -r '.browser_pids[]' < .devserver.agent.run | xargs kill -9 2> /dev/null || echo 'No dangling browser PIDs found in .devserver.agent.run'
	pkill -f '$(PWD)/\.browsers' || true

.PHONY: restart
restart: stop start

.PHONY: restart-browser
restart-browser: stop-browser start-browser

.PHONY: restart-agent
restart-agent: stop-agent start-agent

.PHONY: release
release: export PRODUCTION=1
release: setup build test electron-pack electron-verify

# Run the packaged desktop shell against the current dist/site/. Builds first
# so a stale or missing dist/site/ doesn't load an empty window.
# Unset ELECTRON_RUN_AS_NODE — when set (some sandbox/CI harnesses inherit it)
# the Electron binary runs as plain Node and the API never loads.
.PHONY: electron-dev
electron-dev: build
	unset ELECTRON_RUN_AS_NODE; node_modules/.bin/electron .

# Produce installers/archives in dist/release/. Forces a PRODUCTION dist build
# so the bundled app is minified and ships without source maps. Generates the
# platform icons into dist/build/ first.
#
# macOS signing + notarization is wired through electron-builder hooks
# (electron/notarize.cjs + electron/staple-dmg.cjs) using a notarytool
# keychain credential profile. One-time setup:
#   xcrun notarytool store-credentials galacticad-notarytool \
#       --apple-id "<your-apple-id>" \
#       --team-id  "<your-team-id>" \
#       --password "<app-specific-password>"
# Override the profile name with NOTARYTOOL_PROFILE=… if you used another.
# Skip signing + notarization with CSC_IDENTITY_AUTO_DISCOVERY=false.
.PHONY: electron-pack
electron-pack: export PRODUCTION=1
electron-pack: build icons
	unset ELECTRON_RUN_AS_NODE
	node_modules/.bin/electron-builder -c.extraMetadata.version="$(VERSION)"

# Verify the packaged macOS artifacts in dist/release/: every .app is accepted
# by Gatekeeper as a Notarized Developer ID, and every .dmg has a notarization
# ticket stapled (so Gatekeeper validates it offline). Globs by name so it
# tracks the current version/arch automatically. No-op off macOS (the tools are
# macOS-only) or when signing was skipped via CSC_IDENTITY_AUTO_DISCOVERY=false.
.PHONY: electron-verify
electron-verify:
	@if [[ $$(uname) != Darwin ]]; then
		echo "[electron-verify] not macOS; .app/.dmg checks are macOS-only, skipping"
		exit 0
	fi
	if [[ $$CSC_IDENTITY_AUTO_DISCOVERY == false ]]; then
		echo "[electron-verify] CSC_IDENTITY_AUTO_DISCOVERY=false; unsigned build, skipping"
		exit 0
	fi
	shopt -s nullglob
	apps=($(DIST_ROOT)/release/mac*/*.app)
	dmgs=($(DIST_ROOT)/release/*.dmg)
	if (( $${#apps[@]} + $${#dmgs[@]} == 0 )); then
		echo "[electron-verify] no .app/.dmg under $(DIST_ROOT)/release/ — run 'make electron-pack' first"
		exit 1
	fi
	rc=0
	for app in "$${apps[@]}"; do
		echo "[electron-verify] spctl --assess $$app"
		spctl -a -vvv -t execute "$$app" || rc=1
	done
	for dmg in "$${dmgs[@]}"; do
		echo "[electron-verify] stapler validate $$dmg"
		xcrun stapler validate "$$dmg" || rc=1
	done
	if (( rc != 0 )); then
		echo "[electron-verify] FAILED — artifacts not properly signed/notarized/stapled (see above)"
		exit 1
	fi
	echo "[electron-verify] OK — all .app accepted by Gatekeeper, all .dmg stapled"

# Render src/assets/gicon.svg into the platform icon files electron-builder
# auto-picks from buildResources (set to dist/build in electron-builder.yml).
# Requires rsvg-convert + iconutil (macOS) + ImageMagick (`magick`).
.PHONY: icons
icons: $(DIST_ROOT)/build/icon.icns $(DIST_ROOT)/build/icon.ico $(DIST_ROOT)/build/icon.png

ICON_SVG := src/assets/gicon.svg

$(DIST_ROOT)/build/icon.icns: $(ICON_SVG)
	@mkdir -p $(DIST_ROOT)/build
	tmp=$$(mktemp -d)/icon.iconset; mkdir -p "$$tmp"
	for spec in "16 icon_16x16.png" "32 icon_16x16@2x.png" "32 icon_32x32.png" "64 icon_32x32@2x.png" \
	            "128 icon_128x128.png" "256 icon_128x128@2x.png" "256 icon_256x256.png" "512 icon_256x256@2x.png" \
	            "512 icon_512x512.png" "1024 icon_512x512@2x.png"; do \
	    size=$${spec% *}; name=$${spec#* }; \
	    rsvg-convert -w "$$size" -h "$$size" $(ICON_SVG) -o "$$tmp/$$name"; \
	done
	iconutil -c icns "$$tmp" -o $(DIST_ROOT)/build/icon.icns

$(DIST_ROOT)/build/icon.png: $(ICON_SVG)
	@mkdir -p $(DIST_ROOT)/build
	rsvg-convert -w 1024 -h 1024 $(ICON_SVG) -o $(DIST_ROOT)/build/icon.png

$(DIST_ROOT)/build/icon.ico: $(ICON_SVG)
	@mkdir -p $(DIST_ROOT)/build
	tmp=$$(mktemp -d); \
	for s in 16 24 32 48 64 128 256; do \
	    rsvg-convert -w "$$s" -h "$$s" $(ICON_SVG) -o "$$tmp/$$s.png"; \
	done; \
	magick "$$tmp"/16.png "$$tmp"/24.png "$$tmp"/32.png "$$tmp"/48.png "$$tmp"/64.png "$$tmp"/128.png "$$tmp"/256.png $(DIST_ROOT)/build/icon.ico

.PHONY: clean
clean: stop kill-agent-browsers
	rm -rf $(DIST)

.PHONY: scrub
scrub: clean
	rm -rf $(BROWSERS_DIR)
	rm -rf node_modules
	rm -f .devserver*log

.PHONY: fix-newlines
fix-newlines:
	@git ls-files -z | while IFS= read -r -d '' f; do
		$(SED) -i 's/\r$$//' "$$f"
	done

.PHONY: submodules
submodules:
	git submodule update --init --recursive --depth 1

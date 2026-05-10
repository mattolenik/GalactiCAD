SHELL        := bash
DIST         ?= dist
SED          := $(shell [[ $$(uname) == Darwin ]] && echo gsed || echo sed)
export TSX   ?= node_modules/.bin/tsx
export TSC   ?= node_modules/.bin/tsc
BUILD        := $(TSX) --disable-warning=ExperimentalWarning build/build.mts
BROWSERS_CLI := npx @puppeteer/browsers
BROWSERS_DIR := .browsers

ifeq ($(AGENT),true)
export RUN_FILE := .devserver.agent.run
export LOG_FILE := .devserver.agent.log
export PORT ?= 7000
else
export RUN_FILE := .devserver.run
export LOG_FILE := .devserver.log
export PORT ?= 6900
endif

RUNNING_PORT = $(shell jq -r .port "$(RUN_FILE)")

SHELL := bash
.ONESHELL:

default: build test

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
test: check
	$(TSX) --test

.PHONY: check
check: setup
	$(TSC) --noEmit

.PHONY: serve
serve: clean setup
	$(BUILD) -w $(BUILD_FLAGS)

.PHONY: start
start: build
	@if [[ -f "$(RUN_FILE)" ]]; then
		echo "Server running at http://localhost:$(RUNNING_PORT)"
		exit 0
	fi
	nohup $(BUILD) -w $(BUILD_FLAGS) > $(LOG_FILE) 2>&1 &
	i=0
	while (( i < 20 )); do
		sleep 0.2
		if [[ -f "$(RUN_FILE)" ]]; then
			port=$$(jq -r .port "$(RUN_FILE)")
			echo ""
			echo "Server running at http://localhost:$(RUNNING_PORT)"
			break
		fi
		i=$$((i+1))
	done
	echo "View logs at $(LOG_FILE) (run: make logs$(if $(filter true,$(AGENT)), AGENT=true,))"

logs:
	@tail -fn 50 $(LOG_FILE)

.PHONY: stop
stop:
	@if [[ -f "$(RUN_FILE)" ]]; then
		pid=$$(jq -r .pid "$(RUN_FILE)")
		kill -TERM $$pid && rm -f "$(RUN_FILE)"
	fi

.PHONY: restart
restart: stop start

.PHONY: release
release: export PRODUCTION=1
release: build test

.PHONY: clean
clean: stop
	rm -rf $(DIST)
	rm -f .devserver.*

.PHONY: scrub
scrub: clean
	rm -rf $(BROWSERS_DIR)
	rm -rf node_modules

.PHONY: fix-newlines
fix-newlines:
	@git ls-files -z | while IFS= read -r -d '' f; do
		$(SED) -i 's/\r$$//' "$$f"
	done

.PHONY: submodules
submodules:
	git submodule update --init --recursive

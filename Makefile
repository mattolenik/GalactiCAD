MAKEFLAGS    += --no-print-directory --silent
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
else
export RUN_FILE := .devserver.run
export LOG_FILE := .devserver.log
endif

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

logs:
	@tail -fn 50 $(LOG_FILE)

.PHONY: test
test: check
	$(TSX) --test

.PHONY: check
check: setup
	$(TSC) --noEmit

.PHONY: start
start:
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
	port=$$( [[ "$$AGENT" == true ]] && echo $${PORT:-7900} || echo $${PORT:-6900} )
	PORT=$$port nohup $(BUILD) -w $(BUILD_FLAGS) > $(LOG_FILE) 2>&1 &
	i=0
	while (( i < 20 )); do
		if [[ -f "$(RUN_FILE)" ]]; then
			port=$$(jq -r .port "$(RUN_FILE)")
			echo ""
			echo "Server running at http://localhost:$$port"
			break
		fi
		sleep 1
		i=$$((i+1))
	done
	echo "View logs at $(LOG_FILE) (run: make logs$(if $(filter true,$(AGENT)), AGENT=true,))"

.PHONY: start-all
start-all:
	make start AGENT=false
	make start AGENT=true SKIP_SETUP=true

.PHONY: stop
stop:
	@if [[ -f "$(RUN_FILE)" ]]; then
		pid=$$(jq -r .pid "$(RUN_FILE)")
		port=$$(jq -r .port "$(RUN_FILE)")
		if kill -0 $$pid &> /dev/null; then
			echo "Stopping server PID $$pid on port $$port"
			kill -TERM $$pid && rm -f "$(RUN_FILE)" || true
		else
			echo "No server running with PID $$pid, skipping"
		fi
	else
		echo "No server found at $(RUN_FILE), skipping"
	fi

.PHONY: stop-all
stop-all:
	make stop AGENT=false
	make stop AGENT=true

.PHONY: restart
restart: stop start

.PHONY: restart-all
restart-all: stop-all start-all

.PHONY: release
release: export PRODUCTION=1
release: build test

.PHONY: clean
clean: stop
	rm -rf $(DIST)
	rm -f .devserver*log

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

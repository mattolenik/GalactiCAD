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
	port=$$( [[ "$$AGENT" == true ]] && echo $${PORT:-7900} || echo $${PORT:-6900} )
	PORT=$$port nohup $(BUILD) -w $(BUILD_FLAGS) > $(LOG_FILE) 2>&1 &
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
	make _start AGENT=true

.PHONY: stop-agent
stop-agent:
	make _stop AGENT=true

.PHONY: start
start:
	make start-browser
	make start-agent SKIP_SETUP=true

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
	pkill -f '$(PWD)/\.browsers' || true

.PHONY: restart
restart: stop start

.PHONY: restart-browser
restart-browser: stop-browser start-browser

.PHONY: restart-agent
restart-agent: stop-agent start-agent

.PHONY: release
release: export PRODUCTION=1
release: build test

.PHONY: clean
clean: stop kill-agent-browsers
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

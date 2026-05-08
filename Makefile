SHELL           := bash
SED             := $(shell [[ $$(uname) == Darwin ]] && echo gsed || echo sed)
export TSX      ?= node_modules/.bin/tsx
export TSC      ?= node_modules/.bin/tsc
BUILD           := $(TSX) --disable-warning=ExperimentalWarning build/build.mts

# AGENT=true: .devserver.agent.run + .devserver.agent.log + default PORT 7000 (override inherited PORT unless
# PORT is on the command line, e.g. make serve AGENT=true PORT=8080); devserver spawns headless Chrome
# (chromePid in run file; stopped with devserver on SIGINT/SIGTERM or make stop). Else .devserver.run / .devserver.log.
ifeq ($(AGENT),true)
export RUN_FILE := .devserver.agent.run
export LOG_FILE := .devserver.agent.log
export AGENT := true
# Default 7000 unless PORT was set on this make's command line (e.g. make serve AGENT=true PORT=8080).
# Ifdef PORT is wrong here: `make serve-agent` parses the parent with AGENT unset, so the parent
# may already have exported PORT=6900 from $(BUILD) port; the child must still override to 7000.
ifneq ($(origin PORT),command line)
export PORT := 7000
endif
else
export RUN_FILE := .devserver.run
export LOG_FILE := .devserver.log
ifndef PORT
export PORT := $(shell $(BUILD) port)
endif
endif
export PORT

BROWSER         ?= chromium
DIST            ?= dist

.ONESHELL:

default: build test

.PHONY: open
open:
	$(BROWSER) http://localhost:$(PORT)

.PHONY: setup
setup:
	@mkdir -p $(DIST)
	pnpm install

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
start:
	@nohup $(BUILD) -w $(BUILD_FLAGS) > $(LOG_FILE) 2>&1 &
	i=0
	while (( i < 20 )); do
		sleep 0.2
		if [[ -f "$(RUN_FILE)" ]]; then
			port=$$(jq -r .port "$(RUN_FILE)")
			echo ""
			echo "Server running at http://localhost:$$port"
			break
		fi
		i=$$((i+1))
	done
	echo "View logs at $(LOG_FILE) (run: make logs$(if $(filter true,$(AGENT)), AGENT=true,))"

logs:
	@tail -fn 50 $(LOG_FILE)

.PHONY: stop
stop:
	@if [ -f "$(RUN_FILE)" ]; then
		pid=$$(jq -r .pid "$(RUN_FILE)")
		chrome_pid=$$(jq -r '.chromePid // empty' "$(RUN_FILE)")
		if [ -n "$$pid" ] && [ "$$pid" != "null" ]; then
			kill -TERM $$pid || true
			timeout -p -k 5s 5s wait $$pid
		fi
		kill -KILL $$pid 2>/dev/null || true
		kill -KILL $$chrome_pid 2>/dev/null || true
		rm -f "$(RUN_FILE)"
	fi

.PHONY: restart
restart: stop start

.PHONY: serve-agent
serve-agent:
	$(MAKE) serve AGENT=true

.PHONY: start-agent
start-agent:
	$(MAKE) start AGENT=true

.PHONY: logs-agent
logs-agent:
	$(MAKE) logs AGENT=true

.PHONY: stop-agent
stop-agent:
	$(MAKE) stop AGENT=true

.PHONY: restart-agent
restart-agent:
	$(MAKE) restart AGENT=true

.PHONY: release
release: export PRODUCTION=1
release: build test

.PHONY: clean
clean: stop
	rm -rf $(DIST)
	rm -f .devserver.*

.PHONY: fix-newlines
fix-newlines:
	@git ls-files -z | while IFS= read -r -d '' f; do
		$(SED) -i 's/\r$$//' "$$f"
	done

.PHONY: submodules
submodules:
	git submodule update --init --recursive

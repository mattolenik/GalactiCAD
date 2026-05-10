SHELL           := bash
SED             := $(shell [[ $$(uname) == Darwin ]] && echo gsed || echo sed)
export TSX      ?= node_modules/.bin/tsx
export TSC      ?= node_modules/.bin/tsc
BUILD           := $(TSX) --disable-warning=ExperimentalWarning build/build.mts

# AGENT=true: .devserver.agent.run + .devserver.agent.log + default PORT 7000 (override inherited PORT env var)
# (chromePid in run file; stopped with devserver on SIGINT/SIGTERM or make stop). Else .devserver.run / .devserver.log.
ifeq ($(AGENT),true)
export RUN_FILE := .devserver.agent.run
export LOG_FILE := .devserver.agent.log
export AGENT := true
# Default 7000 unless PORT was set on this make's command line (e.g. make serve AGENT=true PORT=8080).
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

# Prefix for headless agent Chrome --user-data-dir under TMPDIR; keep in sync with
# AGENT_HEADLESS_CHROME_USER_DATA_TAG in build/devserver.mts. make stop kills PIDs whose ps line contains
# $(AGENT_HEADLESS_PROFILE_PREFIX)-<devserver pid from run file>.
AGENT_HEADLESS_PROFILE_PREFIX := galacticad-agent-headless-chrome

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
start: build
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
			sleep 0.2
			timeout -p -k 5s 5s sh -c 'while kill -0 $$pid 2>/dev/null; do sleep 0.5; done'
		fi
		kill -KILL $$pid 2>/dev/null || true
		kill -KILL $$chrome_pid 2>/dev/null || true
		if [ -n "$$pid" ] && [ "$$pid" != "null" ]; then
			_tag="$(AGENT_HEADLESS_PROFILE_PREFIX)-$$pid"
			awk -v tag="$$_tag" -v dvpid="$$pid" 'NR>1 && index($$0, tag) != 0 && $$2+0 != dvpid+0 { print $$2 }' <(ps auxww 2>/dev/null) | while read -r _opid; do
				[ -n "$$_opid" ] && kill -KILL "$$_opid" 2>/dev/null || true
			done
		fi
		rm -f "$(RUN_FILE)"
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

.PHONY: fix-newlines
fix-newlines:
	@git ls-files -z | while IFS= read -r -d '' f; do
		$(SED) -i 's/\r$$//' "$$f"
	done

.PHONY: submodules
submodules:
	git submodule update --init --recursive

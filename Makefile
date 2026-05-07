SHELL           := bash
SED             := $(shell [[ $$(uname) == Darwin ]] && echo gsed || echo sed)
export TSX      ?= node_modules/.bin/tsx
export TSC      ?= node_modules/.bin/tsc
export RUN_FILE := .devserver.run
export LOG_FILE := .devserver.log
BROWSER         ?= chromium
DIST            ?= dist
PORT            ?= $(shell $(BUILD) port)
BUILD           := $(TSX) --disable-warning=ExperimentalWarning build/build.mts

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
	nohup $(BUILD) -w $(BUILD_FLAGS) > $(LOG_FILE) 2>&1 &
	@i=0; while (( $$i < 20 )); do \
		sleep 0.2; \
		if [[ -f "$(RUN_FILE)" ]]; then \
			port=$$(jq -r .port "$(RUN_FILE)"); \
			echo ""; \
			echo "Server running at http://localhost:$$port"; \
			break; \
		fi; \
		i=$$((i+1)); \
	done
	@echo "View logs at $(LOG_FILE) or with 'make logs'"

logs:
	@tail -fn 50 $(LOG_FILE)

.PHONY: stop
stop:
	@if [ -f "$(RUN_FILE)" ]; then \
		pid=$$(jq -r .pid "$(RUN_FILE)"); \
		[ -n $$pid ] && kill -TERM $$pid; \
		rm -f "$(RUN_FILE)"; \
	fi

.PHONY: restart
restart: stop start

.PHONY: serve-agent
serve-agent: clean setup
	env RUN_FILE=.devserver.agent.run PORT=7000 $(BUILD) -w $(BUILD_FLAGS)

.PHONY: start-agent
start-agent:
	nohup env RUN_FILE=.devserver.agent.run PORT=7000 $(BUILD) -w $(BUILD_FLAGS) > .devserver.agent.log 2>&1 &
	@i=0; while (( $$i < 20 )); do \
		sleep 0.2; \
		if [[ -f ".devserver.agent.run" ]]; then \
			port=$$(jq -r .port ".devserver.agent.run"); \
			echo ""; \
			echo "Agent devserver at http://localhost:$$port"; \
			break; \
		fi; \
		i=$$((i+1)); \
	done
	@echo "Logs: .devserver.agent.log (make logs-agent)"

.PHONY: logs-agent
logs-agent:
	@tail -fn 50 .devserver.agent.log

.PHONY: stop-agent
stop-agent:
	@if [ -f ".devserver.agent.run" ]; then \
		pid=$$(jq -r .pid ".devserver.agent.run"); \
		[ -n "$$pid" ] && kill -TERM $$pid 2>/dev/null || true; \
		rm -f ".devserver.agent.run"; \
	fi

.PHONY: restart-agent
restart-agent: stop-agent start-agent

.PHONY: release
release: export PRODUCTION=1
release: build test

.PHONY: clean
clean: stop
	rm -rf $(DIST)
	rm -f .devserver.*

.PHONY: fix-newlines
fix-newlines:
	@git ls-files -z | while IFS= read -r -d '' f; do \
		$(SED) -i 's/\r$$//' "$$f"; \
	done

.PHONY: submodules
submodules:
	git submodule update --init --recursive

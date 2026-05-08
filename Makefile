SHELL           := bash
SED             := $(shell [[ $$(uname) == Darwin ]] && echo gsed || echo sed)
export TSX      ?= node_modules/.bin/tsx
export TSC      ?= node_modules/.bin/tsc
BUILD           := $(TSX) --disable-warning=ExperimentalWarning build/build.mts

# AGENT=true: .devserver.agent.run + .devserver.agent.log + default PORT 7000 (optional isolation for automation).
# Default: regular interactive devserver paths (.devserver.run / .devserver.log); browser + /_agent/* use the same server.
ifeq ($(AGENT),true)
export RUN_FILE := .devserver.agent.run
export LOG_FILE := .devserver.agent.log
ifndef PORT
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
	@echo "View logs at $(LOG_FILE) (run: make logs$(if $(filter true,$(AGENT)), AGENT=true,))"

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
	@git ls-files -z | while IFS= read -r -d '' f; do \
		$(SED) -i 's/\r$$//' "$$f"; \
	done

.PHONY: submodules
submodules:
	git submodule update --init --recursive

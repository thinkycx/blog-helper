VERSION := $(shell git describe --tags --always 2>/dev/null || echo "dev")
LDFLAGS := -X main.version=$(VERSION) -s -w
BINARY := blog-helper
GOPROXY := https://goproxy.cn,direct

# Local site paths for dev server — override via env or Makefile.local
# Example: SITE_PRIMARY=/path/to/your-blog SITE_SECONDARY=/path/to/second-blog
MWEB_BASE := $(HOME)/Library/Containers/com.coderforart.MWeb3/Data/Documents/themes/Site
SITE_PRIMARY ?= $(MWEB_BASE)/thinkycx.me
SITE_SECONDARY ?=

.PHONY: build build-linux run test clean deploy dev dev2

# ─── Build ───────────────────────────────────────────────

# Build for current platform
build:
	go build -ldflags "$(LDFLAGS)" -o dist/$(BINARY) ./cmd/server/

# Build for Linux amd64 (deploy target)
build-linux:
	GOPROXY=$(GOPROXY) GOOS=linux GOARCH=amd64 go build \
		-ldflags "$(LDFLAGS)" \
		-o dist/$(BINARY)-linux-amd64 \
		./cmd/server/

# ─── Local Development ───────────────────────────────────

# Start Go backend only (run in terminal 1)
run:
	go run ./cmd/server/ -addr 127.0.0.1:9001 -db ./data/blog-helper.db \
		-allowed-origins "http://localhost:4000,http://localhost:4001,http://127.0.0.1:4000" \
		-debug

# Start dev server for primary site on :4000 (run in terminal 2)
# Serves static files + proxies /api/ → Go backend
dev:
	SITE_DIR="$(SITE_PRIMARY)" PORT=4000 python3 scripts/dev-server.py

# Start dev server for secondary site on :4001 (run in terminal 3, optional)
dev2:
	SITE_DIR="$(SITE_SECONDARY)" PORT=4001 python3 scripts/dev-server.py

# Shortcut: custom site directory
#   make dev-site SITE_DIR=/path/to/your/blog PORT=5000
dev-site:
	python3 scripts/dev-server.py

# ─── Test & SDK ──────────────────────────────────────────

# Run tests
test:
	go test ./... -v -race -count=1


# Clean build artifacts
clean:
	rm -rf dist/ data/

# ─── Deploy ──────────────────────────────────────────────

# Deploy: customize via env or use blog-helper-deploy.sh for full workflow
SERVER ?= your-server.com
DEPLOY_PATH ?= /opt/blog-helper

deploy: build-linux
	scp dist/$(BINARY)-linux-amd64 $(SERVER):$(DEPLOY_PATH)/$(BINARY)
	ssh $(SERVER) 'sudo systemctl restart blog-helper'
	@echo "Deployed. Verify: curl https://$(SERVER)/api/v1/health"

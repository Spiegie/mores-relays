#!/usr/bin/env bash
# Wrapper for @playwright/mcp on NixOS.
# Browsers come from nixpkgs (PLAYWRIGHT_BROWSERS_PATH); nothing is downloaded.
export PLAYWRIGHT_BROWSERS_PATH="@browsers@"
# System Chrome does not exist on NixOS; default to the nixpkgs chromium build.
# Overridable via env or --browser.
export PLAYWRIGHT_MCP_BROWSER="${PLAYWRIGHT_MCP_BROWSER:-chromium}"
# Without this the MCP would try to create its profile directory inside the
# read-only nix store (it defaults to the registry directory).
export PLAYWRIGHT_MCP_USER_DATA_DIR="${PLAYWRIGHT_MCP_USER_DATA_DIR:-${XDG_CACHE_HOME:-$HOME/.cache}/playwright-mcp}"
exec "@node@/bin/node" "@out@/lib/node_modules/@playwright/mcp/cli.js" "$@"

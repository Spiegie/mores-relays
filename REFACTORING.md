# Refactoring log

This document records the refactoring work done on branch
`refactor/playwright-and-frontend`, including the reasoning behind each
decision and how it was verified. It is a historical record — for current
usage see the [README](README.md) and [DEPLOYMENT.md](DEPLOYMENT.md).

## 1. Playwright MCP via the flake

**Goal:** make the Playwright MCP server (used by Mistral Vibe for browser
automation) work on NixOS, driven entirely by this project's flake.

**Problem:** the vibe config referenced `mcp-server-playwright`, which does
not exist on NixOS. The npm package `@playwright/mcp` bundles a
`playwright-core` that expects to download browser builds at runtime —
impossible in the nix store — and its default browser channel is system
Google Chrome, which does not exist on NixOS.

**Solution:**

- New flake output `packages.playwright-mcp` builds `@playwright/mcp`
  0.0.80 with `buildNpmPackage`.
- The MCP's `playwright-core` is pinned to **stable 1.63.0** (via the
  vendored `nix/playwright-mcp/package.json` + lock) because that is the
  playwright version in this flake's nixpkgs, and its expected browser
  revisions (chromium 1243, firefox 1543, webkit 2359) match the
  `pkgs.playwright.browsers` package exactly. Nothing is downloaded at
  runtime: the wrapper sets `PLAYWRIGHT_BROWSERS_PATH` to the nixpkgs
  browsers.
- The wrapper (`nix/playwright-mcp/wrapper.sh`) additionally
  - defaults `PLAYWRIGHT_MCP_BROWSER=chromium` (overridable via env or
    `--browser`), because the upstream default channel `chrome` has no
    system binary on NixOS;
  - defaults `PLAYWRIGHT_MCP_USER_DATA_DIR` to
    `${XDG_CACHE_HOME:-$HOME/.cache}/playwright-mcp`, because without it
    the MCP tries to create its profile inside the read-only nix store.
- The vendored files are assembled into the source via `runCommand`
  instead of `postPatch`, because the `npmDeps` fixed-output derivation
  needs the lockfile in the source tree it evaluates.

**Version pinning rule:** when nixpkgs updates its `playwright` package,
the MCP must be re-pinned to the `@playwright/mcp` release whose
`playwright-core` matches the nixpkgs playwright version (compare
`browsers.json` revisions against the dirs in `pkgs.playwright.browsers`).

**Vibe wiring:** `~/.vibe/config.toml` now launches the MCP with
`nix run /home/spiegie/git/morse-relay#playwright-mcp`.

**Verified:** JSON-RPC session over stdio (initialize, tools/list,
browser_navigate, browser_snapshot) against example.com and against the
running morse-chat server; the full E2E suite below also runs through
this MCP.

## 2. Frontend language: English

**Decision:** the UI was a German/English mix (Kalibrieren, Tabelle,
wort-gap, Passwort hint vs. Connect, Scratchpad, Hold SPACE...). The
server, README, DEPLOYMENT.md, `index.html` (`lang="en"`) and the commit
history are all English, and the project is public on GitHub — so the UI
is now uniformly **English**.

All German strings were translated in place (calibration events, room
tempo event, training feedback, password placeholder, @bpm hint, gap
labels, replay tooltip, Morse table overlay headings).

## 3. Mode buttons rework

**Problem:** Chat, Scratchpad and Mobile sat in one button row, but they
are not one dimension: Chat/Scratchpad are mutually exclusive modes,
while Mobile is an input method (touch button vs. spacebar). The Chat
button never appeared active while touch input was on, and the mobile
toggle looked like a third mode.

**Solution:** two segmented controls with a single source of truth each:

- **Mode:** `Chat | Scratchpad` — active state is only the `scratchpad`
  boolean.
- **Input:** `Spacebar | Touch` — active state is only the `mobileMode`
  boolean.

## 4. Error traceability

**Server (`morse-relais.ts`):**

- Socket, parse and send failures log the client id (and nick where
  known): `[client-... ] socket error:`, `[client-...] failed to parse
  message: ... raw: <first 200 chars>`.
- Unknown message types log at warn level with client context.
- HTTP layer logs 403 (path traversal) and 404s with method + path, and
  static-file read failures log the underlying error instead of
  swallowing it.
- `unhandledRejection` / `uncaughtException` handlers log full stacks;
  uncaught exceptions exit(1) so a supervisor restarts a broken process
  instead of it limping on.

**Client (`morse-chat-browser-client.tsx`):**

- `ws.onerror` logs the event; `ws.onclose` logs code + reason and shows
  `connection lost (code ...)` in the transcript for any non-normal
  close (1000 = user-initiated reconnect stays silent).
- Unparseable server messages are logged with the raw payload.
- An `ErrorBoundary` wraps the app: render crashes now show the error
  stack and a Reload button instead of a white screen, and log to the
  console with the component stack.
- Inline SVG favicon in `index.html` removes the `/favicon.ico` 404
  console noise.

## 5. Morse table: German umlauts

The README claimed umlaut support (Ä Ö Ü ß) but the client's Morse table
did not contain them. Added the standard codes (Ä `.-.-`, Ö `---.`,
Ü `..--`, ß `...--..`) and included them in the table overlay. Training
still picks only A-Z0-9.

## Verification

- `npx tsc --noEmit` — clean.
- `npm run build` — clean.
- `nix build .#playwright-mcp` — builds; wrapper execs the MCP.
- E2E via the Playwright MCP against the production build served by
  `morse-relais.ts` (14 checks, all passing):
  - English UI, no German leftovers
  - Mode segmented control: Scratchpad enters practice mode (Calibrate /
    Start training appear), Chat returns to room UI
  - Input segmented control: Touch shows the hold button, Spacebar
    restores the SPACE hint
  - Connect, join `#lobby`, key `S` (three dits) via real keyboard
    events, decoded `anon: S` appears in the transcript
  - No browser console errors

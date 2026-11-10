# Deployment Guide - Morse Chat

This guide covers deploying the Morse Chat application using Docker, Buildah, or Docker Compose.

## Quick Start

### Using Docker Compose (Recommended)

```bash
# Start the server
docker-compose up -d

# View logs
docker-compose logs -f morse-server

# Stop the server
docker-compose down
```

The server will be available at:
- **WebSocket**: `ws://localhost:7002`
- **Health**: `http://localhost:7002/health`
- **Web interface**: `http://localhost:3001` (via `npm run dev`)

### Using Docker Directly

```bash
# Build the image
docker build -t morse-chat .

# Run the container
docker run -d --name morse-server -p 7002:7002 morse-chat

# View logs
docker logs -f morse-server
```

### Using Buildah

```bash
# Make the build script executable
chmod +x buildah-build.sh

# Build the image
./buildah-build.sh

# Run with podman
podman run -d --name morse-app -p 7002:7002 federated-morse-chat:latest
```

## Configuration

### Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `NODE_ENV` | production | Node.js environment |
| `ADMIN_TOKEN` | - | Admin authentication token (env var; `--admin-token` CLI flag takes precedence). Prefer the env var so the token doesn't appear in `docker inspect` / `ps` |

### Command Line Options

The server accepts the following command-line arguments:

```
--port <port>           WebSocket/HTTP server port (default: 7002)
--name <name>           Server name for identification
--admin-token <token>   Admin authentication token
```

Example with all options:
```bash
docker run -d --name morse-server \
  -p 7002:7002 \
  morse-chat \
  server --port 7002 --name my-server --admin-token my-secret
```

Note: admin features are disabled entirely unless `--admin-token` is set.


## TLS / reverse proxy example (nginx)

The `nginx` service in `docker-compose.yml` is an **example** grouped under the
`development` profile. For production you decide yourself how to expose the
service (your own reverse proxy, TLS termination, published ports, ...).
The example below shows one way with nginx:

### Step 1: Prepare SSL Certificates

Create a directory for SSL certificates:
```bash
mkdir -p ssl
# Copy your certificates to ssl/
# - fullchain.pem (or cert.pem + chain.pem combined)
# - privkey.pem
```

### Step 2: Build the client

```bash
npm run build   # outputs to dist/
```

### Step 3: Configure nginx.conf

Edit `nginx.conf` and update:
- `server_name morse.example.com;` to your domain
- SSL certificate paths if different

### Step 4: Deploy with Docker Compose

```bash
# Start the server plus the nginx example (development profile)
docker-compose --profile development up -d
# or only server + nginx, without the vite dev service:
docker-compose --profile development up -d morse-server nginx
```

This will:
- Start the Morse server on port 7002 (internal)
- Start Nginx on port 80/443 (external)
- Nginx serves the built client from `dist/` and proxies WebSocket at `/ws`
- All traffic will be encrypted with TLS

Clients connect to:
- `https://morse.example.com` for the web interface
- `wss://morse.example.com/ws` for WebSocket connections

The browser client automatically derives its WebSocket URL from the page origin, so no manual configuration is needed.

## Development Mode

For development with hot-reload:

```bash
# Start with development profile (morse-server + vite dev + nginx example)
docker-compose --profile development up -d
# or only the vite dev service on top of an already running server:
docker-compose --profile development up -d morse-dev

# Or run Vite dev server directly
npm run dev
```

The dev server will be available at `http://localhost:3001` with hot-reload.

## Build and Push to Registry

### Using Docker

```bash
# Build and tag
docker build -t myregistry/federated-morse-chat:v1.0.0 .

# Push to registry
docker push myregistry/federated-morse-chat:v1.0.0
```

### Using Buildah

```bash
# Build and push
./buildah-build.sh my-morse-chat v1.0.0 myregistry.com
```

### Using Podman

```bash
# Build with podman
podman build -t myregistry/federated-morse-chat:v1.0.0 .

# Push to registry
podman push myregistry/federated-morse-chat:v1.0.0
```

## Health Checks

The server exposes an HTTP health endpoint at `/health` on the same port as the WebSocket server. The container health check uses it:

```bash
# Check container health
docker inspect --format='{{json .State.Health}}' morse-server | jq

# Or query the endpoint directly
curl http://localhost:7002/health
```

## Logs and Monitoring

```bash
# View server logs
docker-compose logs -f morse-server

# View all logs
docker-compose logs -f

# Check running containers
docker-compose ps
```

## Custom Configuration

### Room with Password

To create a password-protected room:
```bash
# Connect to server with admin token
docker exec -it morse-server sh
# Inside container: use a WebSocket client to authenticate and create room
```

Or send these messages via WebSocket (see "Admin Access and WebSocket Protocol" below):
```json
// Authenticate as admin (requires ADMIN_TOKEN on the server)
{"t": "auth", "token": "your-admin-token"}

// Create password-protected room
{"t": "create-room", "room": "secret-room", "pass": "my-password"}
```

### Room with BPM Suffix

Join a room with a BPM suffix to set the timing:
```json
// Join room with 300 BPM
{"t": "join", "room": "lobby@300"}
```

This sets the dit length to 200ms (60000/300).

## Admin Access and WebSocket Protocol

The frontend has no admin UI. Admin actions are WebSocket messages sent on an
authenticated connection. Admin status is **per connection** (it does not
survive a reconnect) and requires the server to have `ADMIN_TOKEN` set (env
var, or `--admin-token` CLI flag which takes precedence). If the server has no
token configured, every `auth` fails with `invalid token`.

### Become admin from the browser console (one-liner)

Open the app page, open the devtools console (F12), and paste:

```js
var ws = new WebSocket((location.protocol==='https:'?'wss:':'ws:')+'//'+location.host+'/ws'); ws.onopen=()=>ws.send(JSON.stringify({t:'auth',token:'PUT_TOKEN_HERE'})); ws.onmessage=e=>console.log('reply:',e.data); ws.onerror=()=>console.log('ws error'); ws.onclose=e=>console.log('closed',e.code,e.reason)
```

Replace `PUT_TOKEN_HERE` with the server's `ADMIN_TOKEN` (the `.env` file next
to `docker-compose.yml`). A successful auth logs `reply: {"t":"admin-ok"}`.

Console notes (Firefox/Chrome):

- The console echoing `function onopen` after the paste is normal — that is the
  value of the assignment, the handler was registered.
- `ws.send(...)` returns `undefined` — that is normal; the reply arrives
  asynchronously via `onmessage`.
- Use `var`, not `const`, if you paste the snippet twice — redeclaring
  `const ws` throws `SyntaxError: redeclaration of const ws`.
- If a socket is already open (`ws.readyState === 1`), skip creating a new one
  and just re-send: `ws.send(JSON.stringify({t:'auth',token:'...'}))`.

### Client → server messages

| Message | Fields | Reply / effect |
|---------|--------|----------------|
| `{"t":"hello","nick":"bob"}` | `nick` (trimmed, max 32 chars) | sets nick; replies `rooms` |
| `{"t":"join","room":"lobby@300","pass":"..."}` | `room` (max 64 chars; `@BPM` suffix sets dit length), optional `pass` | `presence` to you and the room; wrong password → `error` |
| `{"t":"leave","room":"lobby"}` | `room` | `presence` with empty `nicks` |
| `{"t":"signal","room":"lobby","on":true,"ts":1700000000000}` | `room`, `on` (bool), `ts` (finite number, ms) | broadcasts `signal` to the room; must be in the room |
| `{"t":"list"}` | — | replies `rooms` |
| `{"t":"auth","token":"..."}` | `token` | `admin-ok`, or `error: invalid token` |
| `{"t":"create-room","room":"secret","pass":"pw"}` | admin only | with `pass`: `admin-ok`; re-sending with a new `pass` changes the room password; without `pass`: no reply |
| `{"t":"delete-room","room":"secret"}` | admin only | `admin-ok`; all room members receive `room-deleted` |
| `{"t":"announce","name":"s1","host":"h","port":7002}` | admin only | logged server-side only; replies `admin-ok` |

### Server → client messages

| Message | Meaning |
|---------|---------|
| `{"t":"rooms","list":[...]}` | room list (after `hello` / `list`) |
| `{"t":"presence","room","nicks":[...]}` | room membership changed |
| `{"t":"signal","room","on","ts","nick","srv"}` | morse key signal from a room member |
| `{"t":"error","msg":"..."}` | e.g. `invalid token`, `not authorized`, `wrong password for #room`, `not in room`, `invalid room name` |
| `{"t":"admin-ok","msg"?}` | admin action accepted |
| `{"t":"room-deleted","room"}` | the room you were in was deleted by an admin |

There is no separate "change room password" command: send `create-room` again
with a new `pass` (it overwrites the stored hash), or `delete-room`. Users
change rooms with `leave` + `join`.

## Troubleshooting

### WebSocket Connection Issues

1. **Browser Autoplay Policy**: Chrome/Firefox require user interaction before playing audio. Click anywhere on the page first.

2. **WebSocket URL**: Ensure you're using `ws://` (not `wss://`) for local development, or `wss://` for production with TLS.

3. **CORS / Origin**: The server rejects WebSocket upgrades whose `Origin` header doesn't match the request host (localhost origins are allowed for development; non-browser clients without an `Origin` header are allowed). If you proxy under a different host, make sure the proxy forwards the original `Host` header (the provided nginx.conf does).

### Build Errors

1. **Out of memory**: Increase Docker memory limit or use `--no-cache`
   ```bash
   docker build --no-cache -t morse-chat .
   ```

2. **Missing dependencies**: Ensure Node.js 18+ is available in the base image

3. **Permission issues**: On Linux, ensure the current user has permission to run Docker/Buildah

## Port Reference

| Port | Protocol | Purpose | Exposed |
|------|----------|---------|---------|
| 7002 | TCP | WebSocket + HTTP health | Yes |
| 3001 | TCP | Vite dev server (development only) | Optional |
| 80 | TCP | Nginx HTTP (TLS example) | Optional |
| 443 | TCP | Nginx HTTPS (TLS example) | Optional |

## Files Reference

- `Dockerfile` - Docker build configuration (multi-stage)
- `buildah-build.sh` - Buildah build script with color output
- `docker-compose.yml` - Docker Compose configuration with profiles
- `nginx.conf` - Nginx reverse proxy configuration with TLS

## Nix

The flake provides two packages (plus the dev shell):

```bash
# Container image (dockerTools, no Docker daemon required)
nix build .#dockerImage
# -> result/ contains the image tarball, load with:
docker load < result

# Playwright MCP server for browser automation (uses nixpkgs Playwright
# browsers; nothing is downloaded at runtime)
nix run .#playwright-mcp
```

The Playwright MCP is pinned to the `@playwright/mcp` release whose
`playwright-core` matches the flake's nixpkgs `playwright` version — see
[REFACTORING.md](REFACTORING.md) for the pinning rule.

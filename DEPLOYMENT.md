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
| `ADMIN_TOKEN` | - | Admin authentication token (set via `--admin-token`) |

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


## Production Deployment with TLS

For production deployment with HTTPS and WSS:

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
# Start all services including nginx
docker-compose --profile production up -d
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
# Start with development profile
docker-compose --profile development up -d

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

Or send these messages via WebSocket:
```json
// Authenticate as admin (requires --admin-token on the server)
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

## Troubleshooting

### WebSocket Connection Issues

1. **Browser Autoplay Policy**: Chrome/Firefox require user interaction before playing audio. Click anywhere on the page first.

2. **WebSocket URL**: Ensure you're using `ws://` (not `wss://`) for local development, or `wss://` for production with TLS.

3. **CORS**: The server allows all origins by default. If you need to restrict, modify the server code.

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
| 80 | TCP | Nginx HTTP (production) | Optional |
| 443 | TCP | Nginx HTTPS (production) | Optional |

## Files Reference

- `Dockerfile` - Docker build configuration (multi-stage)
- `buildah-build.sh` - Buildah build script with color output
- `docker-compose.yml` - Docker Compose configuration with profiles
- `nginx.conf` - Nginx reverse proxy configuration with TLS

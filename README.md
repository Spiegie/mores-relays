# Morse Chat

A chat where nobody types text. Participants key Morse code using the spacebar or a touch button; the raw on/off timing signals travel over WebSocket to a server and are relayed to everyone in the room. Text only comes into existence at the receiving end, when each client decodes the signal timing into characters.

## How it works

```
Browser client ──WebSocket──▶ Server ──▶ all clients in the room
```

- The sender keys dits and dahs (spacebar or touch). Nothing is sent as text.
- Signals are transmitted as `on`/`off` timestamps, not characters.
- Each receiver decodes the timing locally. Every remote participant gets their own decoder, so people keying at different speeds (BPM) are still decoded correctly.
- All timing derives from a single unit: the dit length in milliseconds. `BPM = 60000 / unit` (default 160 ms = 375 BPM).
- Rooms with a `@bpm` suffix (e.g. `lobby@300`) set the tempo on join.
- A built-in calibration mode (tap 8 dits) measures your personal keying speed.

## Features

- Real-time Morse relay over WebSocket with room-based presence
- Optional password-protected rooms (SHA-256 hashed)
- Admin mode (`--admin-token`) to create/delete rooms and set passwords
- Message accumulation: decoded letters collect into lines, flushed after idle
- Replay: recorded signals can be played back via WebAudio, timed exactly by timestamp
- Extended Morse table incl. German umlauts (Ä Ö Ü ß), punctuation and prosigns (SOS, SK, VE)
- HTTP health endpoint on the same port as the WebSocket server

## Quick start (development)

Prerequisites: Node.js >= 18.

```bash
npm install

# Terminal 1: start the server
npm run serve            # tsx morse-relais.ts server --port 7002 --name nix-server

# Terminal 2: start the client with hot reload
npm run dev              # http://localhost:3001
```

Open http://localhost:3001 in two browser tabs, join the same room (e.g. `lobby`), and start keying.

> If you hear no sound in a receiving tab, click anywhere on the page first — browser autoplay policy requires a user interaction before audio can play.

## Server options

```
tsx morse-relais.ts server --port 7002 --name my-server [--admin-token secret]
```

| Option | Default | Description |
|--------|---------|-------------|
| `--port` | 7002 | WebSocket + HTTP health port |
| `--name` | server | Server name (shown in health endpoint) |
| `--admin-token` | - | Enables admin features; without it they are disabled entirely |

Health check: `curl http://localhost:7002/health`

## Rooms

- Rooms are implicit: joining creates the room if it does not exist.
- `lobby@300` joins a room that sets the tempo to 300 BPM (200 ms dit). Note that `lobby` and `lobby@300` are different rooms.
- Passwords can only be set when a room is created; an existing room cannot be hijacked by re-creating it with a different password.
- Admins can delete rooms, which kicks all clients in that room.

## Deployment

Docker, Buildah/Podman, Docker Compose and a production setup with nginx (TLS, WSS) are described in [DEPLOYMENT.md](DEPLOYMENT.md). A Nix flake is provided for Nix users.

## Project structure

```
├── morse-relais.ts                  # Single-file WebSocket server (TypeScript)
├── morse-chat-browser-client.tsx    # React client (pure JS/JSX)
├── src/main.tsx                     # Client entry point
├── index.html                       # HTML shell
├── vite.config.ts                   # Vite config (dev proxy /ws -> 7002)
├── Dockerfile / Buildahfile         # Container builds
├── docker-compose.yml               # Dev + production profiles
├── nginx.conf                       # TLS termination + WebSocket proxy
└── flake.nix                        # Nix build & dev shell
```

## License

[MIT](LICENSE)

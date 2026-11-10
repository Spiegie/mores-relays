#!/usr/bin/env tsx

// =============================================================================
// Morse-Relais Server - Single Server Edition
// Simplified version without federation
// =============================================================================

import { WebSocketServer, WebSocket } from 'ws';
import { createHash, timingSafeEqual } from 'crypto';
import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFile } from 'fs/promises';
import { existsSync, statSync } from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ---------------------------------------------------------------------------
//  Configuration
// ---------------------------------------------------------------------------

interface ServerConfig {
  port: number;
  name: string;
  adminToken?: string;
}

// ---------------------------------------------------------------------------
//  Server State
// ---------------------------------------------------------------------------

class MorseRelayServer {
  private wss: WebSocketServer;
  private httpServer: ReturnType<typeof createServer>;
  private clients: Map<WebSocket, { id: string; nick: string; rooms: Set<string>; msgTimes: number[]; connectedAt: number }>;
  private rooms: Map<string, Set<WebSocket>>;
  private roomPasses: Map<string, string>;
  private id: string;
  private config: ServerConfig;
  private admins: Set<WebSocket>;
  private distDir: string;
  private startedAt: number;

  constructor(config: ServerConfig) {
    this.config = config;
    this.id = `${config.name || 'server'}-${Date.now()}`;
    this.startedAt = Date.now();
    // dist/ sits next to this file both in the repo and in the nix/docker image
    this.distDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
    this.clients = new Map();
    this.rooms = new Map();
    this.roomPasses = new Map();
    this.admins = new Set();

    // HTTP server: health endpoint + static frontend + WebSocket upgrade
    this.httpServer = createServer((req, res) => {
      if (req.method === 'GET' && req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: this.config.name, clients: this.clients.size }));
        return;
      }
      if (req.method === 'GET' || req.method === 'HEAD') {
        this.serveStatic(req, res);
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });

    // Create WebSocket server on top of the HTTP server.
    // maxPayload caps message size: signals are tiny JSON, 16 KiB is generous.
    this.wss = new WebSocketServer({ server: this.httpServer, maxPayload: 16 * 1024 });

    // Set up WebSocket routing
    this.setupWebSocket();

    // Start listening
    this.start();
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      if (!this.originAllowed(req)) {
        ws.close(1008, 'origin not allowed');
        return;
      }
      this.handleClient(ws);
    });
  }

  // Browsers always send an Origin header on WebSocket upgrades; non-browser
  // clients usually don't. Allow same-host origins and localhost (dev),
  // reject everything else to prevent cross-site WebSocket hijacking.
  private originAllowed(req: IncomingMessage): boolean {
    const origin = req.headers.origin;
    if (!origin) return true;
    let originHost: string;
    try {
      originHost = new URL(origin).host;
    } catch {
      return false;
    }
    if (originHost === (req.headers.host || '')) return true;
    const hostname = originHost.split(':')[0];
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
  }

  // Serves the built frontend (Vite output in dist/). Extensionless paths
  // fall back to index.html so SPA routing works; hashed assets are immutable.
  private async serveStatic(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let pathname: string;
    try {
      pathname = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname);
    } catch {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('bad request');
      return;
    }

    const rel = path.normalize(pathname).replace(/^[/\\]+/, '');
    const filePath = path.join(this.distDir, rel);
    if (filePath !== this.distDir && !filePath.startsWith(this.distDir + path.sep)) {
      console.warn(`[http] ${req.method} ${req.url} -> 403 (path traversal blocked)`);
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('forbidden');
      return;
    }

    let target = filePath;
    if (!existsSync(target) || !statSync(target).isFile()) {
      if (!path.extname(pathname)) {
        target = path.join(this.distDir, 'index.html');
      } else {
        console.warn(`[http] ${req.method} ${req.url} -> 404 (not in ${this.distDir})`);
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
    }

    const types: Record<string, string> = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'text/javascript; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.json': 'application/json',
      '.map': 'application/json',
      '.svg': 'image/svg+xml',
      '.png': 'image/png',
      '.ico': 'image/x-icon',
      '.txt': 'text/plain; charset=utf-8',
      '.webmanifest': 'application/manifest+json',
      '.woff2': 'font/woff2',
    };
    const ext = path.extname(target).toLowerCase();
    const type = types[ext] || 'application/octet-stream';
    const cache = ext === '.html' ? 'no-cache' : 'public, max-age=31536000, immutable';

    try {
      const body = await readFile(target);
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': cache });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch (err) {
      console.error(`[http] ${req.method} ${req.url} -> failed to read ${target}:`, err);
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    }
  }

  private start(): void {
    this.httpServer.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        console.error(`Port ${this.config.port} is already in use.`);
      } else {
        console.error('Server error:', err);
      }
      process.exit(1);
    });

    this.httpServer.listen(this.config.port, () => {
      console.log(`WebSocket server running on ws://localhost:${this.config.port}`);
      console.log(`Health endpoint: http://localhost:${this.config.port}/health`);
      console.log(existsSync(path.join(this.distDir, 'index.html'))
        ? `Frontend: http://localhost:${this.config.port}/`
        : 'Frontend: dist/ not found, serving API only (run `npm run build`)');
      console.log(`Server ID: ${this.id}, Name: ${this.config.name}`);
    });
  }

  private sha256(data: string): string {
    return createHash('sha256').update(data).digest('hex');
  }

  private send(ws: WebSocket, msg: any): void {
    try {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(msg));
      }
    } catch (err) {
      console.error(`[send ${this.clients.get(ws)?.id || 'unknown'}] failed to send:`, err);
    }
  }

  private handleClient(ws: WebSocket): void {
    const clientId = `client-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    
    this.clients.set(ws, {
      id: clientId,
      nick: 'anon',
      rooms: new Set(),
      msgTimes: [],
      connectedAt: Date.now(),
    });

    ws.on('message', (data) => {
      const client = this.clients.get(ws);
      if (!client) return;

      // Sliding-window rate limit: a keyer at 375 BPM sends ~13 msg/s
      // (on+off per element); 120 msg/s leaves generous headroom.
      const now = Date.now();
      client.msgTimes.push(now);
      while (client.msgTimes.length > 0 && client.msgTimes[0] <= now - 1000) {
        client.msgTimes.shift();
      }
      if (client.msgTimes.length > 120) {
        console.warn(`Rate limit exceeded for ${client.nick} (${client.id}), closing`);
        ws.close(1008, 'rate limit exceeded');
        this.removeClient(ws);
        return;
      }

      try {
        const msg = JSON.parse(data.toString());
        if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') {
          this.send(ws, { t: 'error', msg: 'malformed message' });
          return;
        }
        this.handleClientMessage(ws, msg);
      } catch (err) {
        console.error(`[${client.id}] failed to parse message:`, err, `raw: ${data.toString().slice(0, 200)}`);
        this.send(ws, { t: 'error', msg: 'malformed message' });
      }
    });

    ws.on('close', () => {
      this.removeClient(ws);
    });

    ws.on('error', (err) => {
      console.error(`[${clientId}] socket error:`, err);
      this.removeClient(ws);
    });

    // Send welcome message
    this.send(ws, {
      t: 'welcome',
      id: clientId,
      rooms: Array.from(this.rooms.keys()),
    });
  }

  private removeClient(ws: WebSocket): void {
    const client = this.clients.get(ws);
    if (!client) return;

    // Remove from rooms
    for (const room of client.rooms) {
      const roomClients = this.rooms.get(room);
      if (roomClients) {
        roomClients.delete(ws);
        if (roomClients.size === 0) {
          this.rooms.delete(room);
          this.broadcastRoomList();
        } else {
          // Send updated presence
          const nicks = Array.from(roomClients).map((c) => this.clients.get(c)?.nick || 'anon');
          this.broadcastToRoom(room, ws, {
            t: 'presence',
            room,
            nicks,
          });
        }
      }
    }

    // Remove from admin set
    this.admins.delete(ws);

    // Remove from clients map
    this.clients.delete(ws);

    ws.close();
  }

  private handleClientMessage(ws: WebSocket, msg: any): void {
    const client = this.clients.get(ws);
    if (!client) return;

    switch (msg.t) {
      case 'hello':
        client.nick = this.sanitizeNick(msg.nick) || 'anon';
        console.log(`Client connected: ${client.nick} (${client.id})`);

        // Send updated room list
        this.send(ws, {
          t: 'rooms',
          list: Array.from(this.rooms.keys()),
        });
        break;

      case 'join':
        this.handleJoin(ws, msg);
        break;

      case 'leave':
        this.handleLeave(ws, msg);
        break;

      case 'signal':
        this.handleSignal(ws, msg);
        break;

      case 'list':
        this.send(ws, {
          t: 'rooms',
          list: Array.from(this.rooms.keys()),
        });
        break;

      case 'announce':
        this.handleAnnounce(ws, msg);
        break;

      case 'auth':
        this.handleAuth(ws, msg);
        break;

      case 'create-room':
        this.handleCreateRoom(ws, msg);
        break;

      case 'delete-room':
        this.handleDeleteRoom(ws, msg);
        break;

      case 'admin-stats':
        this.handleAdminStats(ws);
        break;

      case 'admin-kick':
        this.handleAdminKick(ws, msg);
        break;

      case 'admin-set-pass':
        this.handleAdminSetPass(ws, msg);
        break;

      case 'admin-broadcast':
        this.handleAdminBroadcast(ws, msg);
        break;

      default:
        console.warn(`[${client.id}/${client.nick}] unknown message type: ${msg.t}`);
    }
  }

  private sanitizeNick(nick: any): string {
    if (typeof nick !== 'string') return '';
    return nick.trim().slice(0, 32);
  }

  private sanitizeRoom(room: any): string {
    if (typeof room !== 'string') return '';
    return room.trim().slice(0, 64);
  }

  private handleJoin(ws: WebSocket, msg: any): void {
    const client = this.clients.get(ws);
    if (!client) return;

    const room = this.sanitizeRoom(msg.room);
    if (!room) {
      this.send(ws, { t: 'error', msg: 'invalid room name' });
      return;
    }
    const pass = typeof msg.pass === 'string' ? msg.pass.slice(0, 256) : '';

    // Check password
    const wanted = this.sha256(pass ?? '');
    const existing = this.roomPasses.get(room);
    
    if (existing !== undefined) {
      if (wanted !== existing) {
        this.send(ws, { t: 'error', msg: `wrong password for #${room}` });
        return;
      }
    } else if (pass && !this.rooms.has(room)) {
      this.roomPasses.set(room, wanted);
    }

    // Leave previous room
    if (client.rooms.size > 0) {
      const prevRoom = Array.from(client.rooms)[0];
      this.handleLeave(ws, { room: prevRoom });
    }

    // Join new room
    client.rooms.add(room);

    let roomClients = this.rooms.get(room);
    if (!roomClients) {
      roomClients = new Set();
      this.rooms.set(room, roomClients);
      this.broadcastRoomList();
    }
    roomClients.add(ws);

    // Send presence update
    const nicks = Array.from(roomClients).map((c) => this.clients.get(c)?.nick || 'anon');
    this.send(ws, {
      t: 'presence',
      room,
      nicks,
    });

    // Broadcast to room
    this.broadcastToRoom(room, ws, {
      t: 'presence',
      room,
      nicks,
    });
  }

  private handleLeave(ws: WebSocket, msg: any): void {
    const client = this.clients.get(ws);
    if (!client) return;

    const room = this.sanitizeRoom(msg.room);
    client.rooms.delete(room);

    const roomClients = this.rooms.get(room);
    if (roomClients) {
      roomClients.delete(ws);
      if (roomClients.size === 0) {
        this.rooms.delete(room);
        this.broadcastRoomList();
      } else {
        // Send updated presence
        const nicks = Array.from(roomClients).map((c) => this.clients.get(c)?.nick || 'anon');
        this.broadcastToRoom(room, ws, {
          t: 'presence',
          room,
          nicks,
        });
      }
    }

    this.send(ws, {
      t: 'presence',
      room,
      nicks: [],
    });
  }

  private handleSignal(ws: WebSocket, msg: any): void {
    const client = this.clients.get(ws);
    if (!client) return;

    const room = this.sanitizeRoom(msg.room);
    if (!client.rooms.has(room)) {
      this.send(ws, { t: 'error', msg: 'not in room' });
      return;
    }

    const { on, ts } = msg;
    if (typeof on !== 'boolean' || typeof ts !== 'number' || !Number.isFinite(ts)) {
      this.send(ws, { t: 'error', msg: 'invalid signal' });
      return;
    }

    // Broadcast to room
    this.broadcastToRoom(room, ws, {
      t: 'signal',
      room,
      on,
      ts,
      nick: client.nick,
      srv: this.config.name,
    });
  }

  // Guard for admin-only actions; replies with a traceable error when denied.
  private requireAdmin(ws: WebSocket, action: string): boolean {
    if (!this.admins.has(ws)) {
      console.warn(`[${this.clients.get(ws)?.id || 'unknown'}] admin action "${action}" denied: not authorized`);
      this.send(ws, { t: 'error', msg: 'not authorized' });
      return false;
    }
    return true;
  }

  private adminLog(ws: WebSocket, action: string, detail: string): void {
    const admin = this.clients.get(ws);
    console.log(`[admin ${admin?.id || 'unknown'}/${admin?.nick || 'anon'}] ${action}: ${detail}`);
  }

  private handleAnnounce(ws: WebSocket, msg: any): void {
    if (!this.requireAdmin(ws, 'announce')) return;

    // Announce is kept for admin visibility but doesn't propagate to other servers
    console.log(`Server announced: ${msg.name || msg.host} at ${msg.host}:${msg.port}`);
    this.send(ws, { t: 'admin-ok', msg: 'announcement logged' });
  }

  private handleAuth(ws: WebSocket, msg: any): void {
    const expected = this.config.adminToken;
    const given = typeof msg.token === 'string' ? msg.token : '';
    if (
      !expected ||
      given.length !== expected.length ||
      !timingSafeEqual(Buffer.from(given), Buffer.from(expected))
    ) {
      console.warn(`[${this.clients.get(ws)?.id || 'unknown'}] admin auth failed`);
      this.send(ws, { t: 'error', msg: 'invalid token' });
      return;
    }

    this.admins.add(ws);
    console.log(`[${this.clients.get(ws)?.id || 'unknown'}/${this.clients.get(ws)?.nick || 'anon'}] admin auth ok`);
    this.send(ws, { t: 'admin-ok' });
  }

  private handleCreateRoom(ws: WebSocket, msg: any): void {
    if (!this.requireAdmin(ws, 'create-room')) return;

    const room = this.sanitizeRoom(msg.room);
    const pass = typeof msg.pass === 'string' ? msg.pass.slice(0, 256) : '';
    if (!room) {
      this.send(ws, { t: 'error', msg: 'invalid room name' });
      return;
    }

    if (pass) {
      this.roomPasses.set(room, this.sha256(pass));
      this.adminLog(ws, 'create-room', `#${room} with password`);
      this.send(ws, { t: 'admin-ok', msg: `room #${room} created with password` });
    } else {
      this.adminLog(ws, 'create-room', `#${room} (no password)`);
      this.send(ws, { t: 'admin-ok', msg: `room #${room} created (no password)` });
    }
  }

  private handleDeleteRoom(ws: WebSocket, msg: any): void {
    if (!this.requireAdmin(ws, 'delete-room')) return;

    const room = this.sanitizeRoom(msg.room);
    if (!room) {
      this.send(ws, { t: 'error', msg: 'invalid room name' });
      return;
    }
    this.destroyRoom(room);
    this.broadcastRoomList();
    this.adminLog(ws, 'delete-room', `#${room}`);
    this.send(ws, { t: 'admin-ok', msg: `room #${room} deleted` });
  }

  private handleAdminStats(ws: WebSocket): void {
    if (!this.requireAdmin(ws, 'admin-stats')) return;

    const clients = Array.from(this.clients.values()).map((c) => ({
      id: c.id,
      nick: c.nick,
      rooms: Array.from(c.rooms),
      connectedAt: c.connectedAt,
    }));
    const rooms = Array.from(this.rooms.entries()).map(([name, set]) => ({
      name,
      members: Array.from(set).map((c) => this.clients.get(c)?.nick || 'anon'),
      hasPass: this.roomPasses.has(name),
    }));
    this.send(ws, {
      t: 'admin-stats',
      name: this.config.name,
      uptime: Date.now() - this.startedAt,
      clients,
      rooms,
    });
  }

  private handleAdminKick(ws: WebSocket, msg: any): void {
    if (!this.requireAdmin(ws, 'admin-kick')) return;

    const targetId = typeof msg.clientId === 'string' ? msg.clientId : '';
    const reason = typeof msg.reason === 'string' ? msg.reason.slice(0, 200) : '';
    for (const [socket, info] of this.clients) {
      if (info.id === targetId) {
        this.adminLog(ws, 'kick', `${info.nick} (${info.id})${reason ? ` — ${reason}` : ''}`);
        this.send(socket, { t: 'kicked', msg: reason || undefined });
        this.removeClient(socket);
        this.send(ws, { t: 'admin-ok', msg: `kicked ${info.nick}` });
        return;
      }
    }
    this.send(ws, { t: 'error', msg: `no such client: ${targetId}` });
  }

  private handleAdminSetPass(ws: WebSocket, msg: any): void {
    if (!this.requireAdmin(ws, 'admin-set-pass')) return;

    const room = this.sanitizeRoom(msg.room);
    const pass = typeof msg.pass === 'string' ? msg.pass.slice(0, 256) : '';
    if (!room) {
      this.send(ws, { t: 'error', msg: 'invalid room name' });
      return;
    }

    if (pass) {
      this.roomPasses.set(room, this.sha256(pass));
      this.adminLog(ws, 'set-pass', `#${room} password set`);
      this.send(ws, { t: 'admin-ok', msg: `password set for #${room}` });
    } else {
      this.roomPasses.delete(room);
      this.adminLog(ws, 'set-pass', `#${room} password removed`);
      this.send(ws, { t: 'admin-ok', msg: `password removed for #${room}` });
    }
  }

  private handleAdminBroadcast(ws: WebSocket, msg: any): void {
    if (!this.requireAdmin(ws, 'admin-broadcast')) return;

    const text = typeof msg.msg === 'string' ? msg.msg.trim().slice(0, 500) : '';
    if (!text) {
      this.send(ws, { t: 'error', msg: 'empty broadcast' });
      return;
    }

    const payload = { t: 'admin-broadcast', msg: text };
    if (msg.room) {
      const room = this.sanitizeRoom(msg.room);
      const roomClients = this.rooms.get(room);
      if (!roomClients) {
        this.send(ws, { t: 'error', msg: `no such room: #${room}` });
        return;
      }
      for (const c of roomClients) this.send(c, payload);
      this.adminLog(ws, 'broadcast', `#${room} (${roomClients.size} clients): ${text}`);
      this.send(ws, { t: 'admin-ok', msg: `broadcast sent to #${room} (${roomClients.size} clients)` });
    } else {
      for (const c of this.clients.keys()) this.send(c, payload);
      this.adminLog(ws, 'broadcast', `all (${this.clients.size} clients): ${text}`);
      this.send(ws, { t: 'admin-ok', msg: `broadcast sent to all (${this.clients.size} clients)` });
    }
  }

  private destroyRoom(room: string): void {
    const set = this.rooms.get(room);
    if (set) {
      for (const c of [...set]) {
        this.clients.get(c)?.rooms.delete(room);
        this.send(c, { t: 'room-deleted', room });
      }
      this.rooms.delete(room);
    }
    this.roomPasses.delete(room);
  }

  private broadcastToRoom(room: string, exclude: WebSocket, msg: any): void {
    const roomClients = this.rooms.get(room);
    if (!roomClients) return;

    for (const c of roomClients) {
      if (c !== exclude && c.readyState === WebSocket.OPEN) {
        this.send(c, msg);
      }
    }
  }

  // Push the current room list to every connected client so the sidebar
  // stays live when rooms appear or disappear.
  private broadcastRoomList(): void {
    const list = Array.from(this.rooms.keys());
    for (const c of this.clients.keys()) {
      this.send(c, { t: 'rooms', list });
    }
  }
}

// ---------------------------------------------------------------------------
//  CLI Interface
// ---------------------------------------------------------------------------

function parseArgs(args: string[]): ServerConfig {
  const config: Partial<ServerConfig> = {
    port: 7002,
    name: 'morse-server',
  };

  for (let i = 2; i < args.length; i++) {
    switch (args[i]) {
      case '--port': {
        const p = parseInt(args[++i], 10);
        if (!Number.isNaN(p) && p > 0 && p < 65536) config.port = p;
        break;
      }
      case '--name':
        config.name = args[++i];
        break;
      case '--admin-token':
        config.adminToken = args[++i];
        break;
    }
  }

  // Env fallback (CLI wins); empty string counts as unset.
  if (!config.adminToken && process.env.ADMIN_TOKEN) {
    config.adminToken = process.env.ADMIN_TOKEN;
  }

  return config as ServerConfig;
}

function printUsage(): void {
  console.log(`
Morse-Relais Server (Single Server Edition)
============================================

Usage:
  tsx morse-relais.ts server [options]

Server Options:
  --port <port>        WebSocket server port (default: 7002)
  --name <name>       Server name (default: morse-server)
  --admin-token <token>   Admin authentication token (or ADMIN_TOKEN env var)

Example:
  tsx morse-relais.ts server --port 7002 --name my-server

Browser clients connect to: ws://localhost:<port>
`);
}

// ---------------------------------------------------------------------------
//  Main
// ---------------------------------------------------------------------------

const args = process.argv;

// Traceability: log anything that escapes the normal handlers with a full
// stack before dying, so crashes in production logs are diagnosable.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled promise rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  process.exit(1);
});

if (args.length < 3) {
  printUsage();
  process.exit(1);
}

const command = args[2];

switch (command) {
  case 'server':
    const config = parseArgs(args);
    console.log('Starting Morse-Relais server (single server mode)...');
    new MorseRelayServer(config);
    break;

  case 'client':
    console.log('Raw TCP CLI client mode (not yet implemented)');
    break;

  case 'help':
  case '--help':
  case '-h':
    printUsage();
    break;

  default:
    console.error(`Unknown command: ${command}`);
    printUsage();
    process.exit(1);
}

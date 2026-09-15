#!/usr/bin/env tsx

// =============================================================================
// Morse-Relais Server - Single Server Edition
// Simplified version without federation
// =============================================================================

import { WebSocketServer, WebSocket } from 'ws';
import { createHash, timingSafeEqual } from 'crypto';
import { createServer } from 'http';

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
  private clients: Map<WebSocket, { id: string; nick: string; rooms: Set<string> }>;
  private rooms: Map<string, Set<WebSocket>>;
  private roomPasses: Map<string, string>;
  private id: string;
  private config: ServerConfig;
  private admins: Set<WebSocket>;

  constructor(config: ServerConfig) {
    this.config = config;
    this.id = `${config.name || 'server'}-${Date.now()}`;
    this.clients = new Map();
    this.rooms = new Map();
    this.roomPasses = new Map();
    this.admins = new Set();

    // HTTP server: health endpoint + WebSocket upgrade
    this.httpServer = createServer((req, res) => {
      if (req.method === 'GET' && (req.url === '/health' || req.url === '/')) {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, name: this.config.name, clients: this.clients.size }));
        return;
      }
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('not found');
    });

    // Create WebSocket server on top of the HTTP server
    this.wss = new WebSocketServer({ server: this.httpServer });

    // Set up WebSocket routing
    this.setupWebSocket();

    // Start listening
    this.start();
  }

  private setupWebSocket(): void {
    this.wss.on('connection', (ws: WebSocket) => {
      this.handleClient(ws);
    });
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
      console.error('Error sending message:', err);
    }
  }

  private handleClient(ws: WebSocket): void {
    const clientId = `client-${Date.now()}-${Math.random().toString(36).substring(2, 11)}`;
    
    this.clients.set(ws, {
      id: clientId,
      nick: 'anon',
      rooms: new Set(),
    });

    ws.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        this.handleClientMessage(ws, msg);
      } catch (err) {
        console.error('Error parsing client message:', err);
      }
    });

    ws.on('close', () => {
      this.removeClient(ws);
    });

    ws.on('error', (err) => {
      console.error('Client error:', err);
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

      default:
        console.log('Unknown message type:', msg.t);
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
    const pass = typeof msg.pass === 'string' ? msg.pass : '';

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

  private handleAnnounce(ws: WebSocket, msg: any): void {
    if (!this.admins.has(ws)) {
      this.send(ws, { t: 'error', msg: 'not authorized' });
      return;
    }

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
      this.send(ws, { t: 'error', msg: 'invalid token' });
      return;
    }

    this.admins.add(ws);
    this.send(ws, { t: 'admin-ok' });
  }

  private handleCreateRoom(ws: WebSocket, msg: any): void {
    if (!this.admins.has(ws)) {
      this.send(ws, { t: 'error', msg: 'not authorized' });
      return;
    }

    const room = this.sanitizeRoom(msg.room);
    const pass = msg.pass;
    if (!room) {
      this.send(ws, { t: 'error', msg: 'invalid room name' });
      return;
    }

    if (pass) {
      const hash = this.sha256(pass);
      this.roomPasses.set(room, hash);
      this.send(ws, { t: 'admin-ok', msg: `room ${room} created with password` });
    }
  }

  private handleDeleteRoom(ws: WebSocket, msg: any): void {
    if (!this.admins.has(ws)) {
      this.send(ws, { t: 'error', msg: 'not authorized' });
      return;
    }

    const room = this.sanitizeRoom(msg.room);
    if (!room) {
      this.send(ws, { t: 'error', msg: 'invalid room name' });
      return;
    }
    this.destroyRoom(room);

    this.send(ws, { t: 'admin-ok', msg: `room ${room} deleted` });
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
  --admin-token <token>   Admin authentication token

Example:
  tsx morse-relais.ts server --port 7002 --name my-server

Browser clients connect to: ws://localhost:<port>
`);
}

// ---------------------------------------------------------------------------
//  Main
// ---------------------------------------------------------------------------

const args = process.argv;

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

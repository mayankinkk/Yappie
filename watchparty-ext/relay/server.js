import { WebSocketServer } from "ws";
import { randomBytes } from "node:crypto";
import { createServer } from "node:http";

const PORT = Number(process.env.PORT || 8787);
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O/1/I
const ROOM_LEN = 6;
const MAX_ROOMS = 500;
const MAX_PER_ROOM = 50;
const MSG_PER_SEC = 20;
const CHAT_MAX_LEN = 500;
const NAME_MAX_LEN = 24;
const PING_MS = 25_000;

/** @typedef {{ id: string, name: string, joinedAt: number, ws: import("ws").WebSocket, tokens: number, lastRefill: number }} Peer */
/** @typedef {{ code: string, peers: Map<string, Peer>, createdAt: number }} Room */

/** @type {Map<string, Room>} */
const rooms = new Map();

function makeCode() {
  const bytes = randomBytes(ROOM_LEN);
  let out = "";
  for (let i = 0; i < ROOM_LEN; i++) out += ROOM_ALPHABET[bytes[i] % ROOM_ALPHABET.length];
  return out;
}

function createRoom() {
  if (rooms.size >= MAX_ROOMS) return null;
  for (let attempt = 0; attempt < 8; attempt++) {
    const code = makeCode();
    if (!rooms.has(code)) {
      const room = { code, peers: new Map(), createdAt: Date.now() };
      rooms.set(code, room);
      return room;
    }
  }
  return null;
}

/** Host is the peer who has been in the room longest — server-authoritative. */
function hostIdOf(room) {
  let best = null;
  for (const p of room.peers.values()) {
    if (!best || p.joinedAt < best.joinedAt) best = p;
  }
  return best ? best.id : null;
}

function rosterOf(room) {
  const hostId = hostIdOf(room);
  return [...room.peers.values()]
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map((p) => ({ id: p.id, name: p.name, host: p.id === hostId }));
}

function send(ws, msg) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
}

function broadcast(room, msg, exceptId) {
  for (const p of room.peers.values()) {
    if (p.id === exceptId) continue;
    send(p.ws, msg);
  }
}

function sanitizeName(raw) {
  const name = String(raw ?? "").trim().slice(0, NAME_MAX_LEN);
  return name || "Guest";
}

/** Token bucket so a single client can't flood the room. */
function allowMsg(peer) {
  const now = Date.now();
  const elapsed = now - peer.lastRefill;
  peer.tokens = Math.min(MSG_PER_SEC, peer.tokens + (elapsed / 1000) * MSG_PER_SEC);
  peer.lastRefill = now;
  if (peer.tokens < 1) return false;
  peer.tokens -= 1;
  return true;
}

function leaveRoom(peer) {
  const room = rooms.get(peer.roomCode);
  if (!room) return;
  const wasHost = hostIdOf(room) === peer.id;
  room.peers.delete(peer.id);
  if (room.peers.size === 0) {
    rooms.delete(peer.roomCode);
    return;
  }
  broadcast(room, { type: "peers", peers: rosterOf(room) });
  broadcast(room, { type: "chat", system: true, text: `${peer.name} left` });
  // If the host dropped, everyone recomputes from the new roster — no special-case
  // message needed, the server-sent host flag is the authority.
  if (wasHost) broadcast(room, { type: "host-changed", hostId: hostIdOf(room) });
}

// Bind to 0.0.0.0 so the relay is reachable when deployed behind a platform
// proxy. Set HOST=127.0.0.1 to keep it local-only.
const HOST = process.env.HOST || "0.0.0.0";

// A plain http server lets us answer /healthz on the same port the platform
// probes, with the WebSocket upgrade handled alongside it.
const httpServer = createServer((req, res) => {
  const url = (req.url || "/").split("?")[0];
  if (url === "/healthz" || url === "/health") {
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ ok: true, rooms: rooms.size, peers: totalPeers(), uptime: process.uptime() }));
    return;
  }
  res.writeHead(404, { "content-type": "text/plain" }).end("not found");
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 });

httpServer.on("upgrade", (req, socket, head) => {
  // The extension connects to the root path; reject anything else so a
  // misconfigured client doesn't silently hang.
  const url = (req.url || "/").split("?")[0];
  if (url !== "/" && url !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});

function totalPeers() {
  let n = 0;
  for (const room of rooms.values()) n += room.peers.size;
  return n;
}

httpServer.listen(PORT, HOST, () => {
  console.log(`[relay] listening on ws://${HOST}:${PORT} (health: /healthz)`);
});

wss.on("connection", (ws) => {
  /** @type {Peer | null} */
  let peer = null;
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  ws.on("message", (raw) => {
    if (!peer) return;
    if (!allowMsg(peer)) return;

    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (!msg || typeof msg.type !== "string") return;

    const room = rooms.get(peer.roomCode);
    if (!room) return;

    switch (msg.type) {
      case "control": {
        const p = msg.payload;
        if (!p || typeof p !== "object") return;
        if (typeof p.videoId !== "string" || typeof p.time !== "number") return;
        if (!Number.isFinite(p.time) || p.time < 0) return;
        // Clients anchor position to receipt time, so ordering rides on a
        // per-sender sequence number rather than a wall clock.
        if (typeof p.seq !== "number" || !Number.isFinite(p.seq)) return;
        broadcast(room, { type: "control", payload: { ...p, senderId: peer.id, senderName: peer.name } }, peer.id);
        break;
      }
      case "sync-request": {
        broadcast(room, { type: "sync-request", senderId: peer.id }, peer.id);
        break;
      }
      case "control-request": {
        broadcast(room, { type: "control-request", senderId: peer.id, senderName: peer.name }, peer.id);
        break;
      }
      case "room-settings": {
        // Only the server-elected host may flip room-wide settings.
        if (hostIdOf(room) !== peer.id) return;
        if (typeof msg.guestsCanControl !== "boolean") return;
        broadcast(room, { type: "room-settings", guestsCanControl: msg.guestsCanControl, senderId: peer.id });
        break;
      }
      case "chat": {
        const text = String(msg.text ?? "").trim().slice(0, CHAT_MAX_LEN);
        if (!text) return;
        broadcast(room, { type: "chat", senderId: peer.id, senderName: peer.name, text, at: Date.now() });
        break;
      }
      case "rename": {
        peer.name = sanitizeName(msg.name);
        broadcast(room, { type: "peers", peers: rosterOf(room) });
        break;
      }
      case "leave": {
        const code = peer.roomCode;
        const name = peer.name;
        room.peers.delete(peer.id);
        peer.roomCode = null;
        send(ws, { type: "left", room: code });
        if (room.peers.size === 0) rooms.delete(code);
        else {
          broadcast(room, { type: "peers", peers: rosterOf(room) });
          broadcast(room, { type: "chat", system: true, text: `${name} left` });
          if (hostIdOf(room) !== msg.hostId) broadcast(room, { type: "host-changed", hostId: hostIdOf(room) });
        }
        break;
      }
      default:
        break;
    }
  });

  ws.on("close", () => {
    if (peer) leaveRoom(peer);
  });

  ws.on("error", () => {
    /* close handler does the cleanup */
  });

  // First message must be a join.
  const onFirstMessage = (raw) => {
    ws.off("message", onFirstMessage);
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      ws.close();
      return;
    }
    if (!msg || msg.type !== "join") {
      ws.close();
      return;
    }
    const code = typeof msg.room === "string" ? msg.room.trim().toUpperCase() : "";
    let room = null;
    if (msg.create === true) {
      room = createRoom();
      if (!room) {
        send(ws, { type: "error", error: "server_full" });
        ws.close();
        return;
      }
    } else {
      room = rooms.get(code);
      if (!room) {
        send(ws, { type: "error", error: "room_not_found" });
        ws.close();
        return;
      }
      if (room.peers.size >= MAX_PER_ROOM) {
        send(ws, { type: "error", error: "room_full" });
        ws.close();
        return;
      }
    }

    const id = typeof msg.id === "string" && msg.id.length <= 64 ? msg.id : randomBytes(16).toString("hex");
    if (room.peers.has(id)) {
      // Reconnect from the same identity: drop the stale socket.
      const stale = room.peers.get(id);
      stale.ws.close();
      room.peers.delete(id);
    }
    peer = {
      id,
      name: sanitizeName(msg.name),
      joinedAt: Date.now(),
      ws,
      roomCode: room.code,
      tokens: MSG_PER_SEC,
      lastRefill: Date.now(),
    };
    room.peers.set(id, peer);
    send(ws, { type: "joined", room: room.code, selfId: id, hostId: hostIdOf(room), peers: rosterOf(room) });
    broadcast(room, { type: "peers", peers: rosterOf(room) }, id);
    broadcast(room, { type: "chat", system: true, text: `${peer.name} joined` });
  };
  ws.on("message", onFirstMessage);
});

const heartbeat = setInterval(() => {
  wss.clients.forEach((ws) => {
    if (ws.isAlive === false) return ws.terminate();
    ws.isAlive = false;
    ws.ping();
  });
}, PING_MS);

// Rooms are only ever populated by live sockets, so an empty room is garbage.
const gc = setInterval(() => {
  for (const [code, room] of rooms) {
    if (room.peers.size === 0) rooms.delete(code);
  }
}, 60_000);

// Platforms send SIGTERM on deploy/restart. Close listeners first so the
// interval can't keep the loop alive, then drain sockets.
function shutdown(signal) {
  console.log(`[relay] ${signal} — shutting down`);
  clearInterval(gc);
  clearInterval(heartbeat);
  wss.clients.forEach((ws) => ws.close(1001, "server shutting down"));
  httpServer.close(() => process.exit(0));
  // Don't hang forever on a straggler socket.
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

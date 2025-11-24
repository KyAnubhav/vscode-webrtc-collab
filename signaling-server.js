// signaling-server.js - Updated, Safe, Render-Ready Signaling Server
const WebSocket = require("ws");
const http = require("http");

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  if (req.url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("OK");
    return;
  }
  res.writeHead(404);
  res.end();
});

const wss = new WebSocket.Server({ server });

/**
 * Rooms:
 * {
 *   roomId: Set<WebSocket>
 * }
 */
const rooms = {};

function cleanupDeadSockets(roomId) {
  if (!rooms[roomId]) return;
  rooms[roomId] = new Set([...rooms[roomId]].filter(ws => ws.readyState === WebSocket.OPEN));
  if (rooms[roomId].size === 0) delete rooms[roomId];
}

function broadcast(roomId, obj, exceptSocket = null) {
  if (!rooms[roomId]) return;
  const msg = JSON.stringify(obj);
  for (const ws of rooms[roomId]) {
    if (ws !== exceptSocket && ws.readyState === WebSocket.OPEN) {
      ws.send(msg);
    }
  }
}

wss.on("connection", ws => {
  let joinedRoom = null;

  ws.on("message", data => {
    let msg = null;
    try {
      msg = JSON.parse(data);
    } catch {
      return;
    }

    if (!msg.type) return;

    // CREATE new room
    if (msg.type === "create") {
      joinedRoom = msg.room;
      rooms[joinedRoom] = rooms[joinedRoom] || new Set();
      rooms[joinedRoom].add(ws);

      ws.send(JSON.stringify({ type: "room-state", count: rooms[joinedRoom].size }));
      return;
    }

    // JOIN existing
    if (msg.type === "join") {
      joinedRoom = msg.room;
      rooms[joinedRoom] = rooms[joinedRoom] || new Set();
      rooms[joinedRoom].add(ws);

      broadcast(joinedRoom, { type: "peer-joined" }, ws);
      ws.send(JSON.stringify({ type: "room-state", count: rooms[joinedRoom].size }));
      return;
    }

    // OFFER / ANSWER / ICE → relay inside room
    if (["offer", "answer", "candidate"].includes(msg.type) && joinedRoom) {
      broadcast(joinedRoom, msg, ws);
    }
  });

  ws.on("close", () => {
    if (joinedRoom && rooms[joinedRoom]) {
      rooms[joinedRoom].delete(ws);
      cleanupDeadSockets(joinedRoom);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server running on port ${PORT}`);
  console.log(`Health: http://0.0.0.0:${PORT}/health`);
});

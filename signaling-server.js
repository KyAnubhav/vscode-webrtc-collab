// Lightweight WebRTC signaling server using WebSockets
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

const wss = new WebSocket.Server({ port: PORT });
console.log("Signaling server running on port", PORT);

const rooms = new Map(); // roomId → Set of sockets

function safeSend(ws, msg) {
  try {
    ws.send(JSON.stringify(msg));
  } catch (err) {
    console.error("WS send error:", err);
  }
}

wss.on("connection", (socket) => {
  let joinedRoom = null;

  socket.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }

    const { type, room, sdp, candidate } = msg;

    // CREATE ROOM
    if (type === "create") {
      joinedRoom = room;
      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room).add(socket);

      safeSend(socket, {
        type: "room-state",
        room,
        count: rooms.get(room).size
      });
      return;
    }

    // JOIN ROOM
    if (type === "join") {
      joinedRoom = room;
      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room).add(socket);

      // Notify host that someone joined
      rooms.get(room).forEach(ws => {
        if (ws !== socket) {
          safeSend(ws, { type: "peer-joined", room });
        }
      });

      safeSend(socket, {
        type: "room-state",
        room,
        count: rooms.get(room).size
      });
      return;
    }

    // OTHER SIGNALS: OFFER / ANSWER / CANDIDATE
    if (["offer", "answer", "candidate"].includes(type)) {
      const members = rooms.get(room);
      if (!members) return;

      members.forEach((ws) => {
        if (ws !== socket) {
          safeSend(ws, { type, room, sdp, candidate });
        }
      });
    }
  });

  socket.on("close", () => {
    if (joinedRoom && rooms.has(joinedRoom)) {
      const set = rooms.get(joinedRoom);
      set.delete(socket);
      if (set.size === 0) rooms.delete(joinedRoom);
    }
  });
});

// Health-check for Render.com
const http = require("http");
http
  .createServer((req, res) => {
    res.writeHead(200);
    res.end("OK");
  })
  .listen(process.env.PORT_HTTP || 3000, () => {
    console.log("HTTP health check running");
  });

const http = require("http");
const WebSocket = require("ws");

const PORT = process.env.PORT || 10000;

// Create one shared HTTP server (Render requires this)
const server = http.createServer((req, res) => {
  res.writeHead(200);
  res.end("OK");
});

const wss = new WebSocket.Server({ server });

// Room map: roomId → Set of sockets
const rooms = new Map();

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
    let msg = null;
    try { msg = JSON.parse(raw); } catch { return; }

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

      // Notify existing members
      rooms.get(room).forEach((ws) => {
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

    // RELAY OFFER / ANSWER / ICE
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

server.listen(PORT, () => {
  console.log("Signaling server running on PORT", PORT);
});

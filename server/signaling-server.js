const WebSocket = require('ws');
const wss = new WebSocket.Server({ port: 8080 });
const rooms = new Map();

console.log("Signaling server running ws://localhost:8080");

wss.on('connection', (ws) => {
  console.log("WS: New connection");

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch {
      console.log("WS: Invalid JSON", raw);
      return;
    }

    console.log("WS RECV:", msg.type, "room:", msg.room || "");

    if (msg.type === 'create' || msg.type === 'join') {
      if (!rooms.has(msg.room)) rooms.set(msg.room, new Set());
      rooms.get(msg.room).add(ws);
      ws.room = msg.room;
      console.log("WS:", msg.type, "=> joined", msg.room);
      return;
    }

    const peers = rooms.get(msg.room) || new Set();
    let count = 0;
    for (const peer of peers) {
      if (peer !== ws && peer.readyState === WebSocket.OPEN) {
        peer.send(JSON.stringify(msg));
        count++;
      }
    }
    console.log("WS RELAY:", msg.type, "to", count, "peers");
  });

  ws.on('close', () => {
    console.log("WS closed");
    if (ws.room && rooms.has(ws.room)) {
      rooms.get(ws.room).delete(ws);
      if (!rooms.get(ws.room).size) rooms.delete(ws.room);
    }
  });
});

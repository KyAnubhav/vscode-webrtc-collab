// server/signaling-server.js
const http = require('http');
const WebSocket = require('ws');

const PORT = parseInt(process.env.PORT || '8080', 10);

const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebRTC signaling server');
});

const wss = new WebSocket.Server({ server });

const rooms = new Map();

wss.on('connection', (ws, req) => {
  console.log('WS: New connection', req.socket.remoteAddress);

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch (err) {
      console.warn('WS: invalid json', raw.toString());
      return;
    }

    console.log('WS RECV:', msg.type, 'room:', msg.room || '');

    // create/join -> track room membership and notify peers
    if (msg.type === 'create' || msg.type === 'join') {
      if (!rooms.has(msg.room)) rooms.set(msg.room, new Set());
      rooms.get(msg.room).add(ws);
      ws.room = msg.room;

      // send back current room state (count) to the sender
      try {
        ws.send(JSON.stringify({ type: 'room-state', room: msg.room, count: rooms.get(msg.room).size }));
      } catch (e) {}

      // notify others that a peer joined
      for (const peer of rooms.get(msg.room)) {
        if (peer !== ws && peer.readyState === WebSocket.OPEN) {
          try {
            peer.send(JSON.stringify({ type: 'peer-joined', room: msg.room }));
          } catch (e) {}
        }
      }

      console.log(`WS: ${msg.type} => joined ${msg.room} (size=${rooms.get(msg.room).size})`);
      return;
    }

    // Otherwise relay to peers
    const peers = rooms.get(msg.room) || new Set();
    let relayed = 0;
    for (const peer of peers) {
      if (peer !== ws && peer.readyState === WebSocket.OPEN) {
        try { peer.send(JSON.stringify(msg)); relayed++; } catch (e) {}
      }
    }
    console.log('WS RELAY:', msg.type, 'to', relayed, 'peers');
  });

  ws.on('close', () => {
    console.log('WS closed');
    if (ws.room && rooms.has(ws.room)) {
      rooms.get(ws.room).delete(ws);
      if (rooms.get(ws.room).size === 0) rooms.delete(ws.room);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Signaling server listening on port ${PORT}`);
});

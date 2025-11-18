// signaling-server.js
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  
  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  if (req.url === '/health' || req.url === '/healthz') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WebRTC signaling server - Healthy');
});

const wss = new WebSocket.Server({ 
  server,
  path: '/'
});

const rooms = new Map();

wss.on('connection', (ws, req) => {
  console.log('WS: New connection from', req.socket.remoteAddress);

  ws.on('message', (raw) => {
    let msg;
    try { 
      msg = JSON.parse(raw); 
    } catch (err) {
      console.warn('WS: invalid json', raw.toString());
      return;
    }

    console.log('WS RECV:', msg.type, 'room:', msg.room || '');

    if (msg.type === 'create' || msg.type === 'join') {
      if (!msg.room) {
        console.warn('WS: No room specified');
        return;
      }
      
      if (!rooms.has(msg.room)) {
        rooms.set(msg.room, new Set());
      }
      rooms.get(msg.room).add(ws);
      ws.room = msg.room;

      // Send room state to the new connection
      try {
        ws.send(JSON.stringify({ 
          type: 'room-state', 
          room: msg.room, 
          count: rooms.get(msg.room).size 
        }));
      } catch (e) {
        console.warn('WS: Error sending room-state');
      }

      // Notify other peers in the room
      for (const peer of rooms.get(msg.room)) {
        if (peer !== ws && peer.readyState === WebSocket.OPEN) {
          try {
            peer.send(JSON.stringify({ 
              type: 'peer-joined', 
              room: msg.room 
            }));
          } catch (e) {
            console.warn('WS: Error notifying peer');
          }
        }
      }

      console.log(`WS: ${msg.type} => joined ${msg.room} (size=${rooms.get(msg.room).size})`);
      return;
    }

    // Relay other messages to peers in the same room
    if (msg.room && rooms.has(msg.room)) {
      const peers = rooms.get(msg.room);
      let relayed = 0;
      for (const peer of peers) {
        if (peer !== ws && peer.readyState === WebSocket.OPEN) {
          try { 
            peer.send(JSON.stringify(msg)); 
            relayed++; 
          } catch (e) {
            console.warn('WS: Error relaying message');
          }
        }
      }
      console.log('WS RELAY:', msg.type, 'to', relayed, 'peers');
    }
  });

  ws.on('close', () => {
    console.log('WS: Connection closed');
    if (ws.room && rooms.has(ws.room)) {
      rooms.get(ws.room).delete(ws);
      if (rooms.get(ws.room).size === 0) {
        rooms.delete(ws.room);
        console.log(`Room ${ws.room} deleted (empty)`);
      }
    }
  });

  ws.on('error', (error) => {
    console.log('WS: Error:', error);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Signaling server running on port ${PORT}`);
  console.log(`WebSocket available at ws://0.0.0.0:${PORT}`);
  console.log(`Health check at http://0.0.0.0:${PORT}/health`);
});
// server/signaling-server.js
const http = require('http');
const WebSocket = require('ws');

const PORT = process.env.PORT || 10000;

const server = http.createServer((req, res) => {
  // CORS headers for all responses
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
  res.end('WebRTC signaling server');
});

const wss = new WebSocket.Server({ 
  server,
  // Handle potential path-based WebSocket connections
  path: '/',
  // Disable client tracking for better performance
  clientTracking: true
});

// Handle WebSocket upgrade
server.on('upgrade', (req, socket, head) => {
  // You can add authentication or validation here if needed
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit('connection', ws, req);
  });
});

const rooms = new Map();

wss.on('connection', (ws, req) => {
  console.log('WS: New connection from', req.socket.remoteAddress);

  ws.isAlive = true;
  
  ws.on('pong', () => {
    ws.isAlive = true;
  });

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
      }
    }
  });

  ws.on('error', (error) => {
    console.log('WS: Error:', error);
  });
});

// Heartbeat to check for dead connections
setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping();
  });
}, 30000);

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Signaling server running on port ${PORT}`);
  console.log(`WebSocket available at ws://0.0.0.0:${PORT}`);
});
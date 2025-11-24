
# WebRTC + Yjs VS Code Collaboration Extension

This project enables real-time collaborative editing in VS Code using:
- WebRTC (peer-to-peer connection)
- Yjs CRDT (conflict-free shared editing)
- A WebSocket signaling server
- A VS Code Webview UI

---

## ⭐ Features
- Real-time collaboration using WebRTC DataChannels  
- Yjs-powered CRDT editing (no conflicting edits, merges automatically)  
- Simple signaling server for peer discovery  
- Cursor sharing, full-document sync, room-based sessions  
- Works without a backend (except signaling)

---

# 🚀 1. Running Locally

## ⚙️ Prerequisites
- Node.js (v16+)  
- VS Code  
- Git  

---

## 📌 Folder Structure
```
your-extension-folder/
│ extension.js
│ package.json
│ signaling-server.js
```

---

# ▶️ 2. Start the Signaling Server (Locally)

Open terminal in the extension folder:

```bash
npm install
npm start
```

This runs:

```
node signaling-server.js
```

You should see:

```
Signaling server running on port XXXX
```

This server relays SDP and ICE candidates between peers.

---

# ▶️ 3. Run the VS Code Extension

1. Open the folder in VS Code  
2. Press **F5** (Run Extension)  
3. A new VS Code Window (Extension Host) opens  
4. Open any file  
5. Run Command Palette → **WebRTC Collab (Yjs)**  
6. Choose:
   - **Host**
   - or **Join**  
7. Enter the same room code on both sides  

Your typing will now sync between both editors.

---

# 🌐 4. Deploy Signaling Server to Render

Render allows you to host your signaling server for free.

## 📁 Step 1: Push repository to GitHub/GitLab

Include:

```
package.json
signaling-server.js
```

---

## ⚙️ Step 2: Configure Render

1. Go to **https://dashboard.render.com/**
2. Click **New → Web Service**
3. Connect your Git repo
4. Set:

### **Build Command**
```
npm install
```

### **Start Command**
```
npm start
```

### Important  
Your signaling server **must** listen on the Render port:

```js
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server on", PORT));
```

---

## 🌍 Step 3: Deploy

Click **Create Web Service**.  
Render will build + run the server.

Your signaling WebSocket URL becomes:

```
wss://your-app.onrender.com
```

Use this URL inside **extension.js**:

```js
const DEFAULT_WSS = "wss://your-app.onrender.com";
```

---

# 🤝 5. Using the Extension (Final Flow)

1. Start signaling server (local or Render)  
2. Run VS Code extension (F5)  
3. Open panel → Host  
4. Share room code  
5. Remote user clicks Join with same room  
6. Start editing collaboratively  
7. Yjs ensures conflict-free text merging  
8. WebRTC ensures low-latency peer-to-peer sync  

---

# 🧪 6. How to Verify Everything Works

### ✔ WebRTC connected  
In the panel logs, you should see:

```
WS connected
DataChannel open
```

### ✔ Yjs merging  
Both users type in same line → no conflicts, text merges.

### ✔ Late join  
User joins later → document instantly syncs.

### ✔ Signaling  
Render dashboard should show incoming WebSocket connections.

---

# 🛠 7. Troubleshooting

### ❌ DataChannel not opening
- Your signaling server may not be reachable  
- Wrong WebSocket URL  
- Mixed HTTP/HTTPS (fix by always using wss://)

### ❌ No connection behind strict NAT
You may need a TURN server.

### ❌ Document resets randomly
Ensure only Yjs controls the text state.

---

# 🎯 8. Roadmap Improvements
- Awareness API (show multiple cursors precisely)
- Per-file rooms
- TURN server for 100% reliability
- Save Yjs snapshots for persistent rooms

---

# ❤️ Credits
You + ChatGPT  
Built with WebRTC, Yjs, and VS Code Webviews.

---


WebRTC Collab (JavaScript, Full-featured)

This repo contains:
- `extension.js` — VS Code extension (JavaScript) that opens a WebView for collaboration.
- `server/signaling-server.js` — WebSocket signaling server (Node.js).

Quick start:
1. Extract the ZIP.
2. Run `npm install` in the project root.
3. (Optional) `npm run server` to run local signaling server on port 8080.
4. In VS Code open the folder, open `extension.js` and press F5 to launch Extension Development Host.
5. In the Extension Host: `Ctrl+Shift+P` → "Start WebRTC Collaboration".

Notes:
- The extension's WebView defaults to a public WSS; change it in the code if you host your own signaling server.
- This ZIP doesn't include node_modules — run `npm install` after extraction.

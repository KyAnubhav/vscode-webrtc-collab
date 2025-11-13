"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const vscode = require("vscode");
let panel = null;
let applyingRemote = false;
let subs = [];
let myId = "";
let myName = "";
let myColor = "";
const COLORS = ["#ff5555", "#55ff55", "#5599ff", "#ffb86c", "#bd93f9", "#f1fa8c", "#ff79c6"];
const userInfo = new Map();
const cursorDecorations = new Map();
const selectionDecorations = new Map();
function activate(context) {
    context.subscriptions.push(vscode.commands.registerCommand("webrtcCollab.start", async () => {
        await openPanel(context);
    }));
}
function deactivate() {
    cleanup();
}
function makeId() {
    return Date.now().toString(36) + "-" + Math.floor(Math.random() * 0xffff).toString(16);
}
function hexToRgba(hex, alpha = 0.25) {
    if (!hex || hex[0] !== "#" || (hex.length !== 7 && hex.length !== 4)) {
        return `rgba(0,0,0,${alpha})`;
    }
    if (hex.length === 4) {
        const r = parseInt(hex[1] + hex[1], 16);
        const g = parseInt(hex[2] + hex[2], 16);
        const b = parseInt(hex[3] + hex[3], 16);
        return `rgba(${r},${g},${b},${alpha})`;
    }
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    return `rgba(${r},${g},${b},${alpha})`;
}
async function openPanel(context) {
    if (panel) {
        panel.reveal(vscode.ViewColumn.Beside);
        return;
    }
    // prompt for display name (you chose option B)
    const typed = await vscode.window.showInputBox({
        prompt: "Enter display name for collaboration",
        placeHolder: "e.g. Anubhav, Sarah",
        value: ""
    });
    myName = (typed && typed.trim()) || `User-${Math.floor(Math.random() * 9000 + 1000)}`;
    myId = makeId();
    myColor = COLORS[Math.floor(Math.random() * COLORS.length)];
    panel = vscode.window.createWebviewPanel("webrtcCollab", "WebRTC Collaboration", vscode.ViewColumn.Beside, {
        enableScripts: true,
        retainContextWhenHidden: true
    });
    panel.webview.html = getHtml(panel.webview);
    // handle messages from webview (which include forwarded DC messages)
    const recv = panel.webview.onDidReceiveMessage(async (msg) => {
        if (!msg || typeof msg.type !== "string")
            return;
        if (msg.type === "dc-open") {
            // send presence (forward to peers)
            panel.webview.postMessage({
                type: "presence",
                id: myId,
                name: myName,
                color: myColor,
                forward: true
            });
            // send full document
            const editor = vscode.window.activeTextEditor;
            if (!editor)
                return;
            const fullText = editor.document.getText();
            panel.webview.postMessage({
                type: "editor-change",
                start: 0,
                end: fullText.length,
                text: fullText,
                forward: true
            });
            return;
        }
        if (msg.type === "presence") {
            if (!msg.id || msg.id === myId)
                return;
            userInfo.set(msg.id, { id: msg.id, name: msg.name || "Unknown", color: msg.color || "#999999" });
            panel.webview.postMessage({ type: "user-list", users: Array.from(userInfo.values()) });
            return;
        }
        if (msg.type === "editor-change") {
            const editor = vscode.window.activeTextEditor;
            if (!editor)
                return;
            try {
                applyingRemote = true;
                if (typeof msg.start === "number" && typeof msg.end === "number") {
                    await editor.edit((ed) => {
                        const s = editor.document.positionAt(msg.start);
                        const e = editor.document.positionAt(msg.end);
                        ed.replace(new vscode.Range(s, e), msg.text);
                    });
                }
                else if (typeof msg.text === "string") {
                    await editor.edit((ed) => {
                        const full = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length));
                        ed.replace(full, msg.text);
                    });
                }
            }
            finally {
                applyingRemote = false;
            }
            return;
        }
        if (msg.type === "cursor") {
            if (!msg.id || msg.id === myId)
                return;
            const editor = vscode.window.activeTextEditor;
            if (!editor)
                return;
            const pos = editor.document.positionAt(msg.pos || 0);
            const range = new vscode.Range(pos, pos);
            if (!cursorDecorations.has(msg.id)) {
                const d = vscode.window.createTextEditorDecorationType({
                    border: `1px solid ${msg.color}`,
                    borderRadius: "2px",
                    overviewRulerColor: msg.color,
                    overviewRulerLane: vscode.OverviewRulerLane.Right
                });
                cursorDecorations.set(msg.id, d);
            }
            const dec = cursorDecorations.get(msg.id);
            editor.setDecorations(dec, [range]);
            return;
        }
        if (msg.type === "selection") {
            if (!msg.id || msg.id === myId)
                return;
            const editor = vscode.window.activeTextEditor;
            if (!editor)
                return;
            const start = editor.document.positionAt(msg.start || 0);
            const end = editor.document.positionAt(msg.end || 0);
            const range = new vscode.Range(start, end);
            if (!selectionDecorations.has(msg.id)) {
                const bg = hexToRgba(msg.color || "#888888", 0.25);
                const d = vscode.window.createTextEditorDecorationType({ backgroundColor: bg });
                selectionDecorations.set(msg.id, d);
            }
            const dec = selectionDecorations.get(msg.id);
            editor.setDecorations(dec, [range]);
            return;
        }
        if (msg.type === "presence-leave") {
            if (!msg.id)
                return;
            userInfo.delete(msg.id);
            panel.webview.postMessage({ type: "user-list", users: Array.from(userInfo.values()) });
            const cd = cursorDecorations.get(msg.id);
            if (cd) {
                cd.dispose();
                cursorDecorations.delete(msg.id);
            }
            const sd = selectionDecorations.get(msg.id);
            if (sd) {
                sd.dispose();
                selectionDecorations.delete(msg.id);
            }
            return;
        }
    });
    subs.push(recv);
    // send local edits to webview (which will forward over DC)
    const send = vscode.workspace.onDidChangeTextDocument((ev) => {
        if (!panel || applyingRemote)
            return;
        if (!ev.contentChanges.length)
            return;
        const doc = ev.document;
        for (const cc of ev.contentChanges) {
            panel.webview.postMessage({
                type: "editor-change",
                start: doc.offsetAt(cc.range.start),
                end: doc.offsetAt(cc.range.end),
                text: cc.text,
                forward: true
            });
        }
    });
    subs.push(send);
    // send cursor & selection updates
    const cursorSend = vscode.window.onDidChangeTextEditorSelection((ev) => {
        if (!panel || applyingRemote)
            return;
        const editor = ev.textEditor;
        if (!editor)
            return;
        const pos = editor.document.offsetAt(editor.selection.active);
        panel.webview.postMessage({
            type: "cursor",
            pos,
            id: myId,
            name: myName,
            color: myColor,
            forward: true
        });
        const sel = editor.selection;
        if (!sel.isEmpty) {
            panel.webview.postMessage({
                type: "selection",
                start: editor.document.offsetAt(sel.start),
                end: editor.document.offsetAt(sel.end),
                id: myId,
                name: myName,
                color: myColor,
                forward: true
            });
        }
        else {
            panel.webview.postMessage({
                type: "selection",
                start: pos,
                end: pos,
                id: myId,
                name: myName,
                color: myColor,
                forward: true
            });
        }
    });
    subs.push(cursorSend);
    panel.onDidDispose(() => cleanup());
    // add self to list and update UI
    userInfo.set(myId, { id: myId, name: myName, color: myColor });
    panel.webview.postMessage({ type: "user-list", users: Array.from(userInfo.values()) });
}
function cleanup() {
    while (subs.length) {
        const d = subs.pop();
        try {
            d?.dispose();
        }
        catch { }
    }
    for (const d of cursorDecorations.values()) {
        try {
            d.dispose();
        }
        catch { }
    }
    for (const d of selectionDecorations.values()) {
        try {
            d.dispose();
        }
        catch { }
    }
    cursorDecorations.clear();
    selectionDecorations.clear();
    userInfo.clear();
    if (panel) {
        try {
            panel.dispose();
        }
        catch { }
        panel = null;
    }
}
function getHtml(webview) {
    const csp = `default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'unsafe-inline' ${webview.cspSource}; connect-src ws: wss: https:`;
    return [
        "<!DOCTYPE html>",
        "<html><head>",
        "<meta charset='UTF-8'>",
        `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
        `<style>
      body { font-family:Segoe UI,Arial,system-ui; margin:12px; }
      .row { margin-bottom:8px; }
      #users { display:flex; gap:8px; margin-top:8px; flex-wrap:wrap; }
      .user { padding:4px 8px; border-radius:12px; color:#111; font-weight:600; }
      #log { background:#111; color:#eee; padding:8px; border-radius:6px; height:110px; overflow:auto; }
      input { padding:4px; }
      button { padding:6px 10px; margin-right:6px; }
    </style>`,
        "</head><body>",
        "<h3>WebRTC Collab — Users & Cursors</h3>",
        "<div class='row'>",
        ` Signaling WS: <input id="ws" value="ws://localhost:8080" style="width:260px;">`,
        ` Room: <input id="room" value="room1" style="width:140px;">`,
        "</div>",
        "<div class='row'>",
        "<button id='host'>Host</button><button id='join'>Join</button><button id='disc' disabled>Disconnect</button>",
        "</div>",
        "<div id='users'></div>",
        "<div id='log'></div>",
        "<script>",
        `(function(){
  const vscode = acquireVsCodeApi();
  const logEl = document.getElementById('log');
  const usersEl = document.getElementById('users');
  const hostBtn = document.getElementById('host');
  const joinBtn = document.getElementById('join');
  const discBtn = document.getElementById('disc');
  const wsInput = document.getElementById('ws');
  const roomInput = document.getElementById('room');

  let pc = null, dc = null, socket = null, role = null, room = null, pending = [];
  let offerSent = false;

  function log(m){ logEl.textContent += m + "\\n"; logEl.scrollTop = logEl.scrollHeight; }
  function setState(s){
    if(s === 'idle'){ hostBtn.disabled = false; joinBtn.disabled = false; discBtn.disabled = true; }
    if(s === 'connecting'){ hostBtn.disabled = true; joinBtn.disabled = true; discBtn.disabled = false; }
    if(s === 'connected'){ hostBtn.disabled = true; joinBtn.disabled = true; discBtn.disabled = false; }
  }

  async function ensurePC(){
    pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]});
    pc.onicecandidate = e => { if(e.candidate && socket && room) socket.send(JSON.stringify({ type:'candidate', room, candidate: e.candidate })); };
    pc.onconnectionstatechange = () => { log('RTC: ' + pc.connectionState); if(pc.connectionState === 'connected') setState('connected'); if(['failed','disconnected','closed'].includes(pc.connectionState)) { log('RTC ended'); reset(); } };
  }

  function wire(ch){
    dc = ch;
    dc.onopen = () => {
      log('DataChannel open');
      try { vscode.postMessage({ type: 'dc-open' }); } catch(e) {}
    };
    dc.onmessage = e => {
      try {
        const m = JSON.parse(e.data);
        try { vscode.postMessage(m); } catch(e) {}
      } catch(e){}
    };
    dc.onclose = () => { log('DC closed'); };
  }

  function updateUserList(users){
    usersEl.innerHTML = '';
    if(!Array.isArray(users)) return;
    for(const u of users){
      const el = document.createElement('div');
      el.className = 'user';
      el.textContent = u.name;
      el.style.background = u.color || '#ddd';
      usersEl.appendChild(el);
    }
  }

  async function start(r){
    reset();
    offerSent = false;
    role = r;
    room = (roomInput.value || 'room1').trim();
    setState('connecting');
    await ensurePC();
    if(role === 'host'){ wire(pc.createDataChannel('code')); } else { pc.ondatachannel = e => wire(e.channel); }

    socket = new WebSocket(wsInput.value);
    socket.onopen = async () => {
      log('WS connected');
      socket.send(JSON.stringify({ type: (role === 'host') ? 'create' : 'join', room }));
      // do NOT create offer immediately; wait for room-state or peer-joined messages
    };

    socket.onmessage = async ev => {
      const msg = JSON.parse(ev.data);

      if (msg.type === 'room-state') {
        log('Room state count=' + msg.count);
        if (role === 'host' && !offerSent && msg.count > 1) {
          offerSent = true;
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.send(JSON.stringify({ type: 'offer', room, sdp: offer }));
          log('Offer sent (room-state)');
        }
        return;
      }

      if (msg.type === 'peer-joined') {
        log('Peer joined notification');
        if (role === 'host' && !offerSent) {
          offerSent = true;
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.send(JSON.stringify({ type: 'offer', room, sdp: offer }));
          log('Offer sent (peer-joined)');
        }
        return;
      }

      if (msg.type === 'offer' && role === 'join') {
        await pc.setRemoteDescription(msg.sdp);
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        socket.send(JSON.stringify({ type: 'answer', room, sdp: ans }));
        log('Answer sent');
        for (const c of pending) { try { await pc.addIceCandidate(c); } catch {} }
        pending = [];
      } else if (msg.type === 'answer' && role === 'host') {
        await pc.setRemoteDescription(msg.sdp);
        log('Answer applied');
        for (const c of pending) { try { await pc.addIceCandidate(c); } catch {} }
        pending = [];
      } else if (msg.type === 'candidate') {
        if (!pc.remoteDescription) {
          pending.push(msg.candidate);
          log('Buffered candidate');
        } else {
          try { await pc.addIceCandidate(msg.candidate); } catch(e) { log('addIceCandidate err'); }
        }
      }
    };

    socket.onclose = () => log('WS closed');
    socket.onerror = () => log('WS error');
  }

  function reset(){
    try{ dc && dc.close(); }catch(e){}
    try{ pc && pc.close(); }catch(e){}
    try{ socket && socket.close(); }catch(e){}
    pc = dc = socket = null; pending = [];
    setState('idle');
    log('Disconnected');
  }

  // Messages from extension -> forward to DC when forward flag present; update UI for user-list
  window.addEventListener('message', ev => {
    const m = ev.data;
    if(!m) return;
    if(m.type === 'user-list'){ updateUserList(m.users); return; }
    if(m.forward && dc && dc.readyState === 'open'){ try { dc.send(JSON.stringify(m)); } catch(e) {} }
  });

  hostBtn.onclick = () => start('host');
  joinBtn.onclick = () => start('join');
  discBtn.onclick = reset;

  setState('idle');
  log('Ready.');
})();`,
        "</script></body></html>"
    ].join("");
}
//# sourceMappingURL=extension.js.map
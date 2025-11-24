// extension.js - VSCode extension with Yjs-over-WebRTC using local UMD bundle
const vscode = require("vscode");
const path = require("path");

let panel = null;
let applyingRemote = false;
let subs = [];

let myId = "";
let myName = "";
let myColor = "";

// Reuse cursor decorations per remote user to avoid lag
const cursorDecorations = new Map();

const COLORS = [
  "#ff5555",
  "#55ff55",
  "#5599ff",
  "#ffb86c",
  "#bd93f9",
  "#f1fa8c",
  "#ff79c6",
];

function activate(context) {
  context.subscriptions.push(
    vscode.commands.registerCommand("webrtcCollab.start", () => {
      openPanel(context);
    })
  );
}
exports.activate = activate;

function deactivate() {
  cleanup();
}
exports.deactivate = deactivate;

function makeId() {
  return (
    Date.now().toString(36) +
    "-" +
    Math.floor(Math.random() * 0xffff).toString(16)
  );
}

function hexToRgba(hex, alpha = 0.22) {
  if (!hex || hex[0] !== "#" || (hex.length !== 7 && hex.length !== 4))
    return `rgba(0,0,0,${alpha})`;

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

function openPanel(context) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  vscode.window
    .showInputBox({
      prompt: "Enter display name for collaboration",
      placeHolder: "e.g. Anubhav",
    })
    .then((typed) => {
      myName =
        (typed && typed.trim()) ||
        `User-${Math.floor(Math.random() * 9000 + 1000)}`;
      myId = makeId();
      myColor = COLORS[Math.floor(Math.random() * COLORS.length)];

      panel = vscode.window.createWebviewPanel(
        "webrtcCollab",
        "WebRTC Collab (Yjs)",
        vscode.ViewColumn.Beside,
        {
          enableScripts: true,
          retainContextWhenHidden: true,
        }
      );

      const yjsOnDisk = path.join(context.extensionPath, "media", "yjs.js");
      const yjsUri = panel.webview.asWebviewUri(vscode.Uri.file(yjsOnDisk));

      panel.webview.html = getHtml(panel.webview, yjsUri);

      const recv = panel.webview.onDidReceiveMessage(async (msg) => {
        if (!msg || typeof msg.type !== "string") return;

        if (msg.type === "profile-update" && msg.profile) {
          myColor = msg.profile.color || myColor;
          panel.webview.postMessage({
            type: "user-list",
            users: [{ id: myId, name: myName, color: myColor }],
          });
          return;
        }

        if (msg.type === "copy") {
          try {
            await vscode.env.clipboard.writeText(msg.text || "");
          } catch {}
          return;
        }

        // DataChannel just opened → send presence + current file text once
        if (msg.type === "dc-open") {
          try {
            panel.webview.postMessage({
              type: "presence",
              id: myId,
              name: myName,
              color: myColor,
              forward: true,
            });

            const editor = vscode.window.activeTextEditor;
            if (editor) {
              const full = editor.document.getText();
              // send current file into Yjs as initial state
              panel.webview.postMessage({
                type: "editor-change",
                text: full,
                forward: false, // don't forward over DC again
                source: "vscode-initial",
              });
            }
          } catch {}
          return;
        }

        if (msg.type === "presence") {
          if (!msg.id || msg.id === myId) return;
          panel.webview.postMessage({
            type: "user-list",
            users: [{ id: msg.id, name: msg.name, color: msg.color }],
          });
          return;
        }

        if (msg.type === "editor-change") {
          // This comes from Yjs (remote/local CRDT result) → apply to VS Code editor
          const editor = vscode.window.activeTextEditor;
          if (!editor) return;
          try {
            applyingRemote = true;
            const newText = typeof msg.text === "string" ? msg.text : "";
            const fullRange = new vscode.Range(
              editor.document.positionAt(0),
              editor.document.positionAt(editor.document.getText().length)
            );
            await editor.edit((ed) => {
              ed.replace(fullRange, newText);
            });
          } finally {
            applyingRemote = false;
          }
          return;
        }

        if (msg.type === "cursor") {
          if (!msg.id || msg.id === myId) return;
          const editor = vscode.window.activeTextEditor;
          if (!editor) return;

          const pos = editor.document.positionAt(msg.pos || 0);
          const range = new vscode.Range(pos, pos);

          // Reuse one decoration per remote user to avoid lag
          let dec = cursorDecorations.get(msg.id);
          if (!dec) {
            dec = vscode.window.createTextEditorDecorationType({
              border: `2px solid ${msg.color || "#ff79c6"}`,
              backgroundColor: hexToRgba(msg.color || "#ff79c6", 0.15),
            });
            cursorDecorations.set(msg.id, dec);
          }

          editor.setDecorations(dec, [range]);
          return;
        }

        if (msg.type === "presence-leave") {
          // clear decorations if needed
          for (const [id, dec] of cursorDecorations.entries()) {
            try {
              dec.dispose();
            } catch {}
            cursorDecorations.delete(id);
          }
          panel.webview.postMessage({ type: "user-list", users: [] });
          return;
        }
      });

      subs.push(recv);

      // Local VS Code edits → push into Yjs (webview) once, but avoid loops
      const send = vscode.workspace.onDidChangeTextDocument((ev) => {
        if (!panel || applyingRemote) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor || ev.document !== editor.document) return;

        const full = ev.document.getText();
        panel.webview.postMessage({
          type: "editor-change",
          text: full,
          forward: true, // Yjs will broadcast to peers
          source: "vscode",
        });
      });

      subs.push(send);

      const cursorSend = vscode.window.onDidChangeTextEditorSelection((ev) => {
        if (!panel || applyingRemote) return;
        const editor = ev.textEditor;
        if (!editor) return;
        const pos = editor.document.offsetAt(editor.selection.active);

        panel.webview.postMessage({
          type: "cursor",
          pos,
          id: myId,
          name: myName,
          color: myColor,
          forward: true,
        });
      });

      subs.push(cursorSend);

      panel.onDidDispose(() => cleanup());

      panel.webview.postMessage({
        type: "user-list",
        users: [{ id: myId, name: myName, color: myColor }],
      });
    });
}

function cleanup() {
  while (subs.length) {
    try {
      subs.pop().dispose();
    } catch {}
  }
  for (const [, dec] of cursorDecorations.entries()) {
    try {
      dec.dispose();
    } catch {}
  }
  cursorDecorations.clear();

  if (panel) {
    try {
      panel.dispose();
    } catch {}
    panel = null;
  }
}

function randRoom(len = 9) {
  const chars =
    "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < len; i++)
    s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function getHtml(webview, yjsUri) {
  const DEFAULT_WSS = "ws://localhost:10000";

  const csp = `
    default-src 'none';
    img-src ${webview.cspSource};
    style-src 'unsafe-inline' ${webview.cspSource};
    script-src 'unsafe-inline' ${webview.cspSource} ${yjsUri};
    connect-src ws: wss: https:;
  `;

  const defaultRoom = randRoom();

  return `
<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
body{font-family:Segoe UI,Arial,system-ui;margin:12px}
.row{margin-bottom:8px}
#users{display:flex;gap:8px;margin-top:8px;flex-wrap:wrap}
.user{padding:4px 8px;border-radius:12px;color:#111;font-weight:600;display:flex;align-items:center;gap:6px}
#log{background:#111;color:#eee;padding:8px;border-radius:6px;height:110px;overflow:auto}
input{padding:6px}
button{padding:6px 10px;margin-right:6px}
.meta{display:flex;gap:8px;align-items:center}
</style>
</head>
<body>

<h3>WebRTC Collaboration (Yjs)</h3>

<div class="row meta">
  Room:
  <input id="room" value="${defaultRoom}" style="width:180px">
  <button id="regen">Regenerate</button>
  <button id="copy">Copy</button>
</div>

<div class="row meta">
  Your Color:
  <input id="color" type="color" value="#ff79c6">
  <button id="applyProfile">Apply</button>
</div>

<div class="row">
  <button id="host">Host</button>
  <button id="join">Join</button>
  <button id="disc" disabled>Disconnect</button>
</div>

<div id="users"></div>
<div id="log"></div>

<!-- LOCAL UMD Yjs bundle -->
<script src="${yjsUri}"></script>

<script>
(function(){
const vscode = acquireVsCodeApi();
const logEl = document.getElementById("log");
const usersEl = document.getElementById("users");

const hostBtn = document.getElementById("host");
const joinBtn = document.getElementById("join");
const discBtn = document.getElementById("disc");

const roomInput = document.getElementById("room");
const regenBtn = document.getElementById("regen");
const copyBtn = document.getElementById("copy");

const colorInp = document.getElementById("color");
const applyProfile = document.getElementById("applyProfile");

const Y = window.Y;
if (!Y) {
  log("ERROR: Yjs did NOT load from local UMD.");
  return;
}

let pc=null, dc=null, socket=null, role=null, room=null, pending=[];
let offerSent=false;

// Yjs state
const ydoc = new Y.Doc();
const ytext = ydoc.getText("codetext");
let isApplyingRemoteY = false;
let lastTextSentFromY = "";

// UI helpers
function log(m){
  logEl.textContent += m + "\\n";
  logEl.scrollTop = logEl.scrollHeight;
}
function setState(s){
  if(s==="idle"){ hostBtn.disabled=false; joinBtn.disabled=false; discBtn.disabled=true; }
  if(s==="connecting"){ hostBtn.disabled=true; joinBtn.disabled=true; discBtn.disabled=false; }
  if(s==="connected"){ hostBtn.disabled=true; joinBtn.disabled=true; discBtn.disabled=false; }
}
function updateUserList(users){
  usersEl.innerHTML="";
  if(!Array.isArray(users)) return;
  for(const u of users){
    const el=document.createElement("div");
    el.className="user";
    el.style.background=u.color||"#ddd";
    el.innerHTML="<span>"+(u.name||"User")+"</span>";
    usersEl.appendChild(el);
  }
}

// Broadcast local Yjs updates over DataChannel
ydoc.on("update", (update) => {
  if (isApplyingRemoteY) return;
  if (!dc || dc.readyState !== "open") return;

  try {
    dc.send(JSON.stringify({
      type: "y-update",
      data: Array.from(update)
    }));
  } catch {}
});

// When Yjs text changes, tell extension (but avoid echo spam)
ytext.observe(() => {
  try {
    const t = ytext.toString();
    if (t === lastTextSentFromY) return;
    lastTextSentFromY = t;
    vscode.postMessage({
      type: "editor-change",
      text: t,
      forward: false
    });
  } catch {}
});

// WebRTC
function ensurePC(){
  pc=new RTCPeerConnection({iceServers:[{urls:"stun:stun.l.google.com:19302"}]});
  pc.onicecandidate=e=>{
    if(e.candidate && socket && room){
      socket.send(JSON.stringify({
        type:"candidate",
        room,
        candidate:e.candidate
      }));
    }
  };
  pc.onconnectionstatechange=()=>{
    log("RTC: " + pc.connectionState);
    if(pc.connectionState==="connected") setState("connected");
    if(["failed","disconnected","closed"].includes(pc.connectionState)){
      log("RTC ended");
      reset();
    }
  };
}

function wire(ch){
  dc=ch;
  dc.onopen=()=>{
    log("DataChannel open");
    vscode.postMessage({ type:"dc-open" });

    // send current Yjs state to peer
    try {
      const full = Y.encodeStateAsUpdate(ydoc);
      dc.send(JSON.stringify({
        type:"y-update",
        data:Array.from(full)
      }));
    } catch {}
  };

  dc.onmessage=e=>{
    let msg;
    try{ msg = JSON.parse(e.data); }catch{ return; }

    if (msg.type === "y-update" && msg.data) {
      try{
        isApplyingRemoteY = true;
        Y.applyUpdate(ydoc, new Uint8Array(msg.data));
      } finally {
        isApplyingRemoteY = false;
      }
      return;
    }

    // forward presence/cursor/editor messages to extension
    vscode.postMessage(msg);
  };

  dc.onclose=()=>log("DC closed");
}

async function start(r){
  reset();
  offerSent=false;
  role=r;

  room=(roomInput.value||"").trim();
  if(!room){
    log("Room cannot be empty");
    return;
  }

  setState("connecting");
  ensurePC();

  if(role==="host"){
    wire(pc.createDataChannel("code"));
  } else {
    pc.ondatachannel = e => wire(e.channel);
  }

  socket = new WebSocket("${DEFAULT_WSS}");
  socket.onopen = () => {
    log("WS connected");
    socket.send(JSON.stringify({
      type: (role === "host") ? "create" : "join",
      room
    }));
  };

  socket.onmessage = async (ev) => {
    const msg = JSON.parse(ev.data);

    if (msg.type === "room-state") {
      log("Room state count=" + msg.count);
      if (role === "host" && !offerSent && msg.count > 1) {
        offerSent = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.send(JSON.stringify({
          type:"offer",
          room,
          sdp:offer
        }));
      }
      return;
    }

    if (msg.type === "peer-joined") {
      log("Peer joined");
      if (role === "host" && !offerSent) {
        offerSent = true;
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.send(JSON.stringify({
          type:"offer",
          room,
          sdp:offer
        }));
      }
      return;
    }

    if (msg.type === "offer" && role === "join") {
      await pc.setRemoteDescription(msg.sdp);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      socket.send(JSON.stringify({
        type:"answer",
        room,
        sdp:ans
      }));
      for (const c of pending) {
        try { await pc.addIceCandidate(c); } catch {}
      }
      pending = [];
      return;
    }

    if (msg.type === "answer" && role === "host") {
      await pc.setRemoteDescription(msg.sdp);
      for (const c of pending) {
        try { await pc.addIceCandidate(c); } catch {}
      }
      pending = [];
      return;
    }

    if (msg.type === "candidate") {
      if (!pc.remoteDescription) {
        pending.push(msg.candidate);
      } else {
        try { await pc.addIceCandidate(msg.candidate); } catch {}
      }
    }
  };

  socket.onerror = () => log("WS error");
  socket.onclose = () => log("WS closed");
}

function reset(){
  try{ dc && dc.close(); }catch{}
  try{ pc && pc.close(); }catch{}
  try{ socket && socket.close(); }catch{}
  pc = dc = socket = null;
  pending = [];
  setState("idle");
  log("Disconnected");
  vscode.postMessage({ type:"presence-leave" });
}

// Messages from extension → into Yjs / DC
window.addEventListener("message", ev => {
  const m = ev.data;
  if (!m) return;

  if (m.type === "user-list") {
    updateUserList(m.users);
    return;
  }

  // Forward presence/cursor/editor to peer via DC when needed
  if (m.forward && dc && dc.readyState === "open") {
    try { dc.send(JSON.stringify(m)); } catch {}
  }

  if (m.type === "editor-change" && typeof m.text === "string") {
    // Avoid echo loops: only update Yjs if text actually differs
    const current = ytext.toString();
    if (current === m.text) return;

    ydoc.transact(() => {
      try { ytext.delete(0, ytext.length); } catch {}
      ytext.insert(0, m.text);
    });

    lastTextSentFromY = m.text;
  }
});

// UI controls
regenBtn.onclick = () => {
  roomInput.value = (Math.random().toString(36).substr(2,9)).toUpperCase();
};
copyBtn.onclick = () => {
  vscode.postMessage({ type:"copy", text: roomInput.value });
};
applyProfile.onclick = () => {
  vscode.postMessage({
    type:"profile-update",
    profile:{ color: colorInp.value }
  });
};

hostBtn.onclick = () => start("host");
joinBtn.onclick = () => start("join");
discBtn.onclick = reset;

setState("idle");
log("Ready. Yjs loaded & WebRTC idle");
})();
</script>

</body>
</html>
`;
}

module.exports = {
  activate,
  deactivate,
};

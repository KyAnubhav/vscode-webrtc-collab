/* extension.js — updated: automatic file sync, versioning fallback, no avatar label, prettier UI */
const vscode = require('vscode');

let panel = null;
let applyingRemote = false;
let subs = [];

let myId = '';
let myName = '';
let myColor = '';
const COLORS = ['#ff5555','#55ff55','#5599ff','#ffb86c','#bd93f9','#f1fa8c','#ff79c6'];

// Document versioning: increment on each local send; used for basic sync/fallback.
let currentDocVersion = 0;
let pendingBatchTimer = null;
let havePendingChanges = false;

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('webrtcCollab.start', () => {
    openPanel(context);
  }));
}
exports.activate = activate;

function deactivate() { cleanup(); }
exports.deactivate = deactivate;

function makeId() {
  return Date.now().toString(36) + '-' + Math.floor(Math.random() * 0xffff).toString(16);
}

function hexToRgba(hex, alpha = 0.22) {
  if (!hex || hex[0] !== '#' || (hex.length !== 7 && hex.length !== 4)) {
    return `rgba(0,0,0,${alpha})`;
  }
  if (hex.length === 4) {
    const r = parseInt(hex[1] + hex[1], 16);
    const g = parseInt(hex[2] + hex[2], 16);
    const b = parseInt(hex[3] + hex[3], 16);
    return `rgba(${r},${g},${b},${alpha})`;
  }
  const r = parseInt(hex.slice(1,3),16);
  const g = parseInt(hex.slice(3,5),16);
  const b = parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${alpha})`;
}

function openPanel(context) {
  if (panel) { panel.reveal(vscode.ViewColumn.Beside); return; }

  // Prompt for display name (quick)
  vscode.window.showInputBox({ prompt: 'Enter display name for collaboration (optional)' }).then(typed => {
    myName = (typed && typed.trim()) || `User-${Math.floor(Math.random()*9000+1000)}`;
    myId = makeId();
    myColor = COLORS[Math.floor(Math.random()*COLORS.length)];

    panel = vscode.window.createWebviewPanel('webrtcCollab','WebRTC Collab',vscode.ViewColumn.Beside,{
      enableScripts: true,
      retainContextWhenHidden: true
    });

    panel.webview.html = getHtml(panel.webview);

    // Receive messages from webview (these will include DC-forwarded messages)
    const recv = panel.webview.onDidReceiveMessage(async (msg) => {
      if (!msg || typeof msg.type !== 'string') return;

      // When DataChannel opens webview notifies extension with 'dc-open'
      if (msg.type === 'dc-open') {
        // send presence and immediate full-document sync to peers
        panel.webview.postMessage({ type:'presence', id: myId, name: myName, color: myColor, forward: true });
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const full = editor.document.getText();
          currentDocVersion++; // bump version for the outgoing sync
          panel.webview.postMessage({ type:'editor-change', start:0, end: full.length, text: full, version: currentDocVersion, forward: true });
        }
        return;
      }

      // If a peer requests full doc, reply by sending our current full doc
      if (msg.type === 'request-full') {
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const full = editor.document.getText();
        currentDocVersion++;
        panel.webview.postMessage({ type:'editor-change', start:0, end: full.length, text: full, version: currentDocVersion, forward: true });
        return;
      }

      // Presence from remote -> forward to UI list
      if (msg.type === 'presence') {
        if (!msg.id || msg.id === myId) return;
        panel.webview.postMessage({ type:'user-list', users: [{ id: msg.id, name: msg.name, color: msg.color }] });
        return;
      }

      // Received editor-change from remote (forwarded over DC)
      if (msg.type === 'editor-change') {
        // If this came from ourselves via forward, ignore
        if (msg.from === myId) return;

        // If incoming version matches our version + 1 (expected), apply; else request full sync
        if (typeof msg.version === 'number' && msg.version === currentDocVersion + 1) {
          // apply edit
          const editor = vscode.window.activeTextEditor;
          if (!editor) {
            // no active editor, ignore
            return;
          }
          try {
            applyingRemote = true;
            if (typeof msg.start === 'number' && typeof msg.end === 'number') {
              await editor.edit(ed => {
                const s = editor.document.positionAt(msg.start);
                const e = editor.document.positionAt(msg.end);
                ed.replace(new vscode.Range(s, e), msg.text);
              });
            } else if (typeof msg.text === 'string') {
              await editor.edit(ed => {
                const full = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length));
                ed.replace(full, msg.text);
              });
            }
            currentDocVersion = msg.version; // accept new version
          } finally { applyingRemote = false; }
        } else {
          // version mismatch -> ask for full sync
          panel.webview.postMessage({ type:'request-full', forward: true });
        }
        return;
      }

      // Cursor/selection forwarded from DC
      if (msg.type === 'cursor') {
        if (!msg.id || msg.id === myId) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const pos = editor.document.positionAt(msg.pos || 0);
        const range = new vscode.Range(pos, pos);
        // decoration: small left border to mark cursor (no label)
        const color = msg.color || '#999999';
        const dec = vscode.window.createTextEditorDecorationType({
          borderLeft: `2px solid ${color}`,
          borderRadius: '0px',
          after: undefined // no label
        });
        editor.setDecorations(dec, [range]);
        // dispose after short timeout to avoid leaking
        setTimeout(() => dec.dispose(), 1200);
        return;
      }

      if (msg.type === 'selection') {
        if (!msg.id || msg.id === myId) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor) return;
        const start = editor.document.positionAt(msg.start || 0);
        const end = editor.document.positionAt(msg.end || 0);
        const dec = vscode.window.createTextEditorDecorationType({ backgroundColor: hexToRgba(msg.color || '#888888', 0.18) });
        editor.setDecorations(dec, [new vscode.Range(start, end)]);
        setTimeout(() => dec.dispose(), 1200);
        return;
      }
    });
    subs.push(recv);

    // Local edits: batch full-document sends (debounced)
    const send = vscode.workspace.onDidChangeTextDocument(ev => {
      if (!panel || applyingRemote) return;
      if (!ev.contentChanges.length) return;
      // mark pending and schedule batch send
      havePendingChanges = true;
      if (pendingBatchTimer) clearTimeout(pendingBatchTimer);
      pendingBatchTimer = setTimeout(() => {
        if (!panel) return;
        const editor = vscode.window.activeTextEditor;
        if (!editor) { havePendingChanges = false; return; }
        const full = editor.document.getText();
        currentDocVersion++;
        panel.webview.postMessage({ type:'editor-change', start:0, end: full.length, text: full, version: currentDocVersion, forward: true, from: myId });
        havePendingChanges = false;
      }, 100); // 100ms debounce: send frequent full-doc updates
    });
    subs.push(send);

    // Cursor & selection sends (lightweight)
    const cursorSend = vscode.window.onDidChangeTextEditorSelection(ev => {
      if (!panel || applyingRemote) return;
      const editor = ev.textEditor;
      if (!editor) return;
      const pos = editor.document.offsetAt(editor.selection.active);
      panel.webview.postMessage({ type:'cursor', pos, id: myId, name: myName, color: myColor, forward: true, from: myId });
      const sel = editor.selection;
      if (!sel.isEmpty) {
        panel.webview.postMessage({ type:'selection', start: editor.document.offsetAt(sel.start), end: editor.document.offsetAt(sel.end), id: myId, name: myName, color: myColor, forward: true, from: myId });
      }
    });
    subs.push(cursorSend);

    panel.onDidDispose(() => cleanup());
    // send our own presence to UI immediately
    panel.webview.postMessage({ type:'user-list', users:[{ id: myId, name: myName, color: myColor }] });
  });
}

function cleanup(){
  while(subs.length){
    const d = subs.pop();
    try { d.dispose(); } catch {}
  }
  if (panel) {
    try { panel.dispose(); } catch {}
    panel = null;
  }
}

// helper to generate random room codes
function randRoom(len = 9) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let s = "";
  for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

function getHtml(webview) {
  // signaling server is hidden (not shown in UI)
  const DEFAULT_WSS = "wss://webrtc-signaling-3rbz.onrender.com";
  const csp = `default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'unsafe-inline' ${webview.cspSource}; connect-src wss: wss: https:`;
  const defaultRoom = randRoom();
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  :root{--bg:#0f1720;--card:#0b1220;--muted:#9aa4b2;--accent:#7dd3fc}
  body{font-family:Segoe UI,Arial,system-ui;background:linear-gradient(180deg,#061021 0%, #071226 100%);color:#e6eef6;margin:16px}
  h2{margin:4px 0 12px 0;font-size:16px}
  .card{background:rgba(255,255,255,0.03);padding:12px;border-radius:10px;box-shadow:0 4px 14px rgba(2,6,23,0.6);margin-bottom:10px}
  .row{display:flex;gap:8px;align-items:center}
  input[type=text]{padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:transparent;color:inherit;width:200px}
  button{padding:8px 10px;border-radius:8px;border:0;background:linear-gradient(90deg,#3b82f6,#8b5cf6);color:white;cursor:pointer}
  button.secondary{background:transparent;border:1px solid rgba(255,255,255,0.06)}
  #users{display:flex;gap:8px;flex-wrap:wrap;margin-top:8px}
  .user{padding:6px 10px;border-radius:999px;color:#071226;font-weight:700}
  #log{height:120px;overflow:auto;padding:8px;border-radius:8px;background:#02060b;color:#9fb0c6;margin-top:8px;font-family:monospace;font-size:12px}
  .meta{display:flex;gap:8px;align-items:center;margin-top:8px}
</style></head><body>
  <h2>WebRTC Collab — fast sync</h2>
  <div class="card">
    <div class="row">
      <label style="min-width:48px">Room</label>
      <input id="room" type="text" value="${defaultRoom}" />
      <button id="regen" class="secondary">Regenerate</button>
      <button id="copy" class="secondary">Copy</button>
      <div style="flex:1"></div>
      <button id="host">Host</button>
      <button id="join">Join</button>
      <button id="disc" disabled>Disconnect</button>
    </div>
    <div class="meta">
      <label style="min-width:48px">Color</label>
      <input id="color" type="color" value="#ff79c6" />
      <button id="apply" class="secondary">Apply</button>
      <div style="flex:1"></div>
      <div id="users"></div>
    </div>
    <div id="log"></div>
  </div>

<script>
(function(){
  // DEFAULT_WSS hidden in UI
  const DEFAULT_WSS = "${DEFAULT_WSS}";
  const logEl = document.getElementById('log');
  const usersEl = document.getElementById('users');
  const hostBtn = document.getElementById('host');
  const joinBtn = document.getElementById('join');
  const discBtn = document.getElementById('disc');
  const roomInput = document.getElementById('room');
  const regenBtn = document.getElementById('regen');
  const copyBtn = document.getElementById('copy');
  const colorInp = document.getElementById('color');
  const applyBtn = document.getElementById('apply');

  function log(m){ logEl.textContent += m + "\\n"; logEl.scrollTop = logEl.scrollHeight; }

  let pc=null, dc=null, socket=null, role=null, room=null, pending=[];

  function setState(s){
    if(s==='idle'){ hostBtn.disabled=false; joinBtn.disabled=false; discBtn.disabled=true; }
    if(s==='connecting'){ hostBtn.disabled=true; joinBtn.disabled=true; discBtn.disabled=false; }
    if(s==='connected'){ hostBtn.disabled=true; joinBtn.disabled=true; discBtn.disabled=false; }
  }

  function updateUserList(users){
    usersEl.innerHTML='';
    if(!Array.isArray(users)) return;
    for(const u of users){
      const el = document.createElement('div'); el.className='user'; el.style.background = u.color || '#ddd'; el.textContent = u.name || 'User';
      usersEl.appendChild(el);
    }
  }

  function ensurePC(){
    pc = new RTCPeerConnection({ iceServers:[{ urls:'stun:stun.l.google.com:19302' }]});
    pc.onicecandidate = e => { if(e.candidate && socket && room) socket.send(JSON.stringify({ type:'candidate', room, candidate: e.candidate })); };
    pc.onconnectionstatechange = () => { log('RTC: ' + pc.connectionState); if(pc.connectionState === 'connected') setState('connected'); if(['failed','disconnected','closed'].includes(pc.connectionState)) { reset(); } };
  }

  function wire(ch){
    dc = ch;
    dc.onopen = () => {
      log('DataChannel open');
      // inform extension host
      try { vscode.postMessage({ type:'dc-open' }); } catch(e) {}
    };
    dc.onmessage = e => {
      try { const m = JSON.parse(e.data); try { vscode.postMessage(m); } catch(e) {} } catch(e) {}
    };
    dc.onclose = () => log('DC closed');
  }

  async function start(r){
    reset();
    role = r;
    room = (roomInput.value||'').trim();
    if(!room){ log('Room cannot be empty'); return; }
    setState('connecting');
    ensurePC();
    if(role === 'host'){ wire(pc.createDataChannel('code')); } else { pc.ondatachannel = e => wire(e.channel); }

    socket = new WebSocket(DEFAULT_WSS);
    socket.onopen = async () => { log('WS connected'); socket.send(JSON.stringify({ type: (role==='host') ? 'create' : 'join', room })); };
    socket.onmessage = async ev => {
      const msg = JSON.parse(ev.data);
      if(msg.type === 'room-state'){
        log('Room members=' + msg.count);
        if(role==='host' && msg.count > 1){
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.send(JSON.stringify({ type:'offer', room, sdp: offer }));
          log('Offer sent');
        }
        return;
      }
      if(msg.type === 'peer-joined'){
        log('Peer joined');
        if(role==='host'){
          const offer = await pc.createOffer();
          await pc.setLocalDescription(offer);
          socket.send(JSON.stringify({ type:'offer', room, sdp: offer }));
          log('Offer sent (peer-joined)');
        }
        return;
      }
      if(msg.type === 'offer' && role==='join'){
        await pc.setRemoteDescription(msg.sdp);
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        socket.send(JSON.stringify({ type:'answer', room, sdp: ans }));
        log('Answer sent');
        for(const c of pending){ try{ await pc.addIceCandidate(c); }catch(e){} }
        pending = [];
      } else if(msg.type === 'answer' && role==='host'){
        await pc.setRemoteDescription(msg.sdp);
        log('Answer applied');
        for(const c of pending){ try{ await pc.addIceCandidate(c); }catch(e){} }
        pending = [];
      } else if(msg.type === 'candidate'){
        if(!pc.remoteDescription){ pending.push(msg.candidate); log('Buffered candidate'); } else { try { await pc.addIceCandidate(msg.candidate); } catch(e){ log('addIceCandidate err'); } }
      }
    };
    socket.onclose = () => log('WS closed');
    socket.onerror = () => log('WS error');
  }

  function reset(){
    try{ dc && dc.close(); }catch(e){} try{ pc && pc.close(); }catch(e){} try{ socket && socket.close(); }catch(e){}
    pc = dc = socket = null; pending = []; setState('idle'); log('Disconnected');
    try { vscode.postMessage({ type:'presence-leave', id: null }); } catch(e) {}
  }

  // forward messages from extension host over DC when available
  window.addEventListener('message', ev => {
    const m = ev.data;
    if(!m) return;
    if(m.type === 'user-list'){ updateUserList(m.users); return; }
    // forward messages that were marked forward:true
    if(m.forward && dc && dc.readyState === 'open'){
      try { dc.send(JSON.stringify(m)); } catch(e) {}
    }
  });

  regenBtn.onclick = () => { roomInput.value = (Math.random().toString(36).substr(2,9)).toUpperCase(); };
  copyBtn.onclick = async () => { try { await navigator.clipboard.writeText(roomInput.value); log('Room copied'); } catch(e) { log('Copy failed'); } };
  applyBtn.onclick = () => { try { vscode.postMessage({ type:'profile-update', profile:{ color: colorInp.value }, forward: true }); } catch(e) {} log('Color applied'); };

  hostBtn.onclick = () => start('host');
  joinBtn.onclick = () => start('join');
  discBtn.onclick = () => reset();

  setState('idle'); log('Ready.');
})();
</script>
</body></html>`;
}

module.exports = { activate, deactivate };

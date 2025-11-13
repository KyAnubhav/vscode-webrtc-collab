const vscode = require('vscode');

let panel = null;
let applyingRemote = false;
let subs = [];

let myId = '';
let myName = '';
let myColor = '';

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('webrtcCollab.start', () => {
    openPanel(context);
  }));
}
exports.activate = activate;

function deactivate() { cleanup(); }
exports.deactivate = deactivate;

function makeId(){ return Date.now().toString(36) + '-' + Math.floor(Math.random()*0xffff).toString(16); }
const COLORS = ['#ff5555','#55ff55','#5599ff','#ffb86c','#bd93f9','#f1fa8c','#ff79c6'];

function openPanel(context){
  if(panel){ panel.reveal(vscode.ViewColumn.Beside); return; }
  vscode.window.showInputBox({ prompt: 'Enter display name (optional)' }).then(name => {
    myName = (name && name.trim()) || `User-${Math.floor(Math.random()*9000+1000)}`;
    myId = makeId();
    myColor = COLORS[Math.floor(Math.random()*COLORS.length)];

    panel = vscode.window.createWebviewPanel('webrtcCollab','WebRTC Collab (Yjs)',vscode.ViewColumn.Beside,{
      enableScripts: true,
      retainContextWhenHidden: true
    });

    panel.webview.html = getHtml(panel.webview);
    // Messages from webview (Yjs events forwarded)
    const recv = panel.webview.onDidReceiveMessage(async (msg) => {
      if(!msg || typeof msg.type !== 'string') return;

      if(msg.type === 'y-update'){
        // apply remote Yjs text to editor
        const editor = vscode.window.activeTextEditor;
        if(!editor) return;
        try{
          applyingRemote = true;
          const full = msg.text;
          await editor.edit(ed => {
            const fullRange = new vscode.Range(editor.document.positionAt(0), editor.document.positionAt(editor.document.getText().length));
            ed.replace(fullRange, full);
          });
        } finally { applyingRemote = false; }
        return;
      }

      if(msg.type === 'awareness'){
        if(msg.users) panel.webview.postMessage({ type:'user-list', users: msg.users });
        return;
      }

      if(msg.type === 'dc-ready'){
        // when provider is ready, send our current editor content to webview to seed Yjs if needed
        const editor = vscode.window.activeTextEditor;
        if(!editor) return;
        const full = editor.document.getText();
        panel.webview.postMessage({ type:'seed-doc', text: full });
        return;
      }
    });
    subs.push(recv);

    // forward local edits to webview (but ignore when applying remote)
    const send = vscode.workspace.onDidChangeTextDocument(ev => {
      if(!panel || applyingRemote) return;
      if(!ev.contentChanges.length) return;
      const doc = ev.document;
      const full = doc.getText();
      panel.webview.postMessage({ type:'local-change', text: full });
    });
    subs.push(send);

    // cursor/selection -> forward lightweight for awareness (Yjs handles via awareness but also send)
    const cursorSend = vscode.window.onDidChangeTextEditorSelection(ev => {
      if(!panel || applyingRemote) return;
      const editor = ev.textEditor; if(!editor) return;
      const pos = editor.document.offsetAt(editor.selection.active);
      const sel = editor.selection;
      panel.webview.postMessage({ type:'cursor', pos, start: editor.document.offsetAt(sel.start), end: editor.document.offsetAt(sel.end) });
    });
    subs.push(cursorSend);

    panel.onDidDispose(()=>cleanup());
  });
}
function cleanup(){
  while(subs.length){ const d = subs.pop(); try{ d.dispose(); }catch{} }
  if(panel){ try{ panel.dispose(); }catch{} panel=null; }
}

function randRoom(len=9){
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  let s=''; for(let i=0;i<len;i++) s+=chars[Math.floor(Math.random()*chars.length)]; return s;
}
function getHtml(webview){
  // hidden signaling server (backend only)
  const DEFAULT_WSS = "wss://webrtc-signaling-3rbz.onrender.com"; // change if needed
  const csp = `default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'unsafe-inline' 'unsafe-eval' ${webview.cspSource} https://unpkg.com; connect-src wss: https:;`;
  const defaultRoom = randRoom();
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><style>
  body{font-family:Segoe UI,Arial,system-ui;background:#071026;color:#e6eef6;margin:12px}
  .card{background:rgba(255,255,255,0.03);padding:12px;border-radius:8px;margin-bottom:10px}
  .row{display:flex;gap:8px;align-items:center}
  input[type=text]{padding:8px;border-radius:6px;border:1px solid rgba(255,255,255,0.06);background:transparent;color:inherit;width:220px}
  button{padding:8px 10px;border-radius:8px;border:0;background:linear-gradient(90deg,#06b6d4,#7c3aed);color:white;cursor:pointer}
  button.secondary{background:transparent;border:1px solid rgba(255,255,255,0.06)}
  #users{display:flex;gap:8px;flex-wrap:wrap;margin-left:8px}
  .user{padding:6px 10px;border-radius:999px;color:#071226;font-weight:700}
  #log{height:120px;overflow:auto;padding:8px;border-radius:8px;background:#02060b;color:#9fb0c6;margin-top:8px;font-family:monospace;font-size:12px}
  label{min-width:48px}
  </style>
  </head><body>
  <div class="card"><div class="row"><label>Room</label><input id="room" type="text" value="${defaultRoom}"/><button id="regen" class="secondary">Regenerate</button><button id="copy" class="secondary">Copy</button><div style="flex:1"></div><button id="host">Host</button><button id="join">Join</button><button id="disc" disabled>Disconnect</button></div>
  <div class="row" style="margin-top:8px"><label>Color</label><input id="color" type="color" value="#ff79c6"/><button id="apply" class="secondary">Apply</button><div style="flex:1"></div><div id="users"></div></div>
  <div id="log"></div></div>

  <!-- Yjs and y-webrtc from CDN -->
  <script src="https://unpkg.com/yjs@13.7.53/dist/yjs.js"></script>
  <script src="https://unpkg.com/y-webrtc@10.2.13/dist/y-webrtc.js"></script>

  <script>
  (function(){
    const vscode = acquireVsCodeApi();
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

    const DEFAULT_WSS = "${DEFAULT_WSS}";
    let doc = null, provider = null, ytext = null, awareness = null;
    let room = null;

    function log(m){ logEl.textContent += m + "\n"; logEl.scrollTop = logEl.scrollHeight; }

    function updateUserList(arr){ usersEl.innerHTML=''; if(!Array.isArray(arr)) return; for(const u of arr){ const el=document.createElement('div'); el.className='user'; el.style.background=u.color||'#ddd'; el.textContent = u.name||'User'; usersEl.appendChild(el); } }

    function ensureY(roomName){
      if(doc) return;
      log('Initializing Yjs for room ' + roomName);
      doc = new Y.Doc();
      // use y-webrtc provider
      provider = new WebrtcProvider(roomName, doc, { signaling: [DEFAULT_WSS] });
      ytext = doc.getText('codetext');
      awareness = provider.awareness;

      // propagate awareness changes to extension UI
      awareness.on('change', () => {
        const states = Array.from(awareness.getStates().values()).map(s => s.user).filter(Boolean);
        vscode.postMessage({ type:'awareness', users: states });
      });

      // when ytext updates, forward full content to extension to apply
      ytext.observe(event => {
        try{
          const full = ytext.toString();
          vscode.postMessage({ type:'y-update', text: full });
        }catch(e){}
      });

      // inform extension that DC/provider is ready
      provider.on('synced', isSynced => {
        log('Yjs synced: ' + isSynced);
        vscode.postMessage({ type:'dc-ready' });
      });
    }

    // apply a full seed doc only if ytext is empty (so initial host seeds)
    function seedIfEmpty(text){
      if(!doc) return;
      if(ytext.length === 0 && typeof text === 'string' && text.length>0){
        doc.transact(() => { ytext.delete(0, ytext.length); ytext.insert(0, text); });
        log('Seeded Yjs document from host');
      }
    }

    // apply local editor change into Yjs (full replace)
    function applyLocalToY(text){
      if(!doc) return;
      doc.transact(() => { ytext.delete(0, ytext.length); ytext.insert(0, text); });
    }

    // awareness local state
    function setLocalAwareness(user){
      if(!awareness) return;
      const states = awareness.getLocalState() || {};
      awareness.setLocalStateField('user', user);
    }

    // UI controls
    regenBtn.onclick = () => { roomInput.value = (Math.random().toString(36).substr(2,9)).toUpperCase(); };
    copyBtn.onclick = async () => { try{ await navigator.clipboard.writeText(roomInput.value); log('Room copied'); }catch(e){ log('Copy failed'); } };
    applyBtn.onclick = () => { try{ const color = colorInp.value; vscode.postMessage({ type:'profile-update', profile:{ color }, forward:true }); log('Color applied'); }catch(e){} };

    hostBtn.onclick = () => {
      room = (roomInput.value||'').trim();
      if(!room){ log('Enter room'); return; }
      ensureY(room);
      setLocalAwareness({ id: null, name: null, color: colorInp.value || '#ff79c6' });
      log('Hosting (Yjs + WebRTC)');
      setTimeout(()=>{ /* no-op */ }, 200);
      hostBtn.disabled = true; joinBtn.disabled = true; discBtn.disabled = false;
    };

    joinBtn.onclick = () => {
      room = (roomInput.value||'').trim();
      if(!room){ log('Enter room'); return; }
      ensureY(room);
      setLocalAwareness({ id: null, name: null, color: colorInp.value || '#ff79c6' });
      log('Joining (Yjs + WebRTC)');
      hostBtn.disabled = true; joinBtn.disabled = true; discBtn.disabled = false;
    };

    discBtn.onclick = () => {
      try{ if(provider) provider.destroy(); }catch(e){} doc = null; provider = null; ytext = null; awareness = null;
      hostBtn.disabled = false; joinBtn.disabled = false; discBtn.disabled = true;
      usersEl.innerHTML=''; log('Disconnected'); vscode.postMessage({ type:'presence-leave' });
    };

    // messages from extension -> webview
    window.addEventListener('message', ev => {
      const m = ev.data;
      if(!m) return;
      if(m.type === 'user-list'){ updateUserList(m.users); return; }
      if(m.type === 'seed-doc'){ seedIfEmpty(m.text); return; }
      if(m.type === 'local-change'){ applyLocalToY(m.text); return; }
      if(m.type === 'profile-update'){ // set awareness fields
        const user = { name: m.profile && m.profile.name ? m.profile.name : 'User', color: m.profile && m.profile.color ? m.profile.color : colorInp.value };
        setLocalAwareness(user);
      }
    });

    log('Ready (Yjs client).');
  })();
  </script>
  </body></html>`;
}

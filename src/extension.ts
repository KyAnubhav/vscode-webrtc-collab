import * as vscode from 'vscode';

let panel: vscode.WebviewPanel | null = null;
let applyingRemote = false;
let subs: vscode.Disposable[] = [];

/**
 * Activate
 */
export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('webrtcCollab.start', () => {
      openPanel(context);
    })
  );
}

/**
 * Deactivate
 */
export function deactivate() {
  cleanup();
}

/**
 * Open the webview panel and wire up messaging
 */
function openPanel(context: vscode.ExtensionContext) {
  if (panel) {
    panel.reveal(vscode.ViewColumn.Beside);
    return;
  }

  panel = vscode.window.createWebviewPanel(
    'webrtcCollab',
    'WebRTC Collaboration',
    vscode.ViewColumn.Beside,
    { enableScripts: true, retainContextWhenHidden: true }
  );

  panel.webview.html = getHtml(panel.webview);

  // ===== Receive messages FROM THE WEBVIEW (i.e. from the peer via webview/DC):
  const recv = panel.webview.onDidReceiveMessage(async (msg: any) => {
    if (!msg || typeof msg.type !== 'string') return;

    // When the webview reports that its DataChannel opened, send the full document
    if (msg.type === 'dc-open') {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;
      const fullText = editor.document.getText();
      // send full document to the webview (the webview will forward it over DC)
      panel!.webview.postMessage({
        type: 'editor-change',
        start: 0,
        end: fullText.length,
        text: fullText
      });
      return;
    }

    // Incoming editor-change from the remote peer
    if (msg.type === 'editor-change') {
      const editor = vscode.window.activeTextEditor;
      if (!editor) return;

      try {
        applyingRemote = true;

        // If start/end provided -> apply range replacement (more efficient)
        if (typeof msg.start === 'number' && typeof msg.end === 'number') {
          await editor.edit((editBuilder) => {
            const startPos = editor.document.positionAt(msg.start);
            const endPos = editor.document.positionAt(msg.end);
            editBuilder.replace(new vscode.Range(startPos, endPos), msg.text);
          });
        } else {
          // Otherwise replace entire document
          await editor.edit((editBuilder) => {
            const fullRange = new vscode.Range(
              editor.document.positionAt(0),
              editor.document.positionAt(editor.document.getText().length)
            );
            editBuilder.replace(fullRange, msg.text);
          });
        }
      } finally {
        applyingRemote = false;
      }
    }
  });
  subs.push(recv);

  // ===== Send local editor changes TO THE WEBVIEW (which forwards them over DC)
  const send = vscode.workspace.onDidChangeTextDocument((ev) => {
    if (!panel || applyingRemote) return;
    if (!ev.contentChanges.length) return;

    const doc = ev.document;
    // For simplicity we send individual changes (start,end,text); this is what the webview expects.
    for (const cc of ev.contentChanges) {
      panel!.webview.postMessage({
        type: 'editor-change',
        start: doc.offsetAt(cc.range.start),
        end: doc.offsetAt(cc.range.end),
        text: cc.text
      });
    }
  });
  subs.push(send);

  // If panel is disposed, cleanup related resources
  panel.onDidDispose(() => cleanup());
}

/**
 * Cleanup disposables & panel reference
 */
function cleanup() {
  while (subs.length) {
    const d = subs.pop();
    try { d?.dispose(); } catch {}
  }
  if (panel) {
    try { panel.dispose(); } catch {}
    panel = null;
  }
}

/**
 * Build the Webview HTML (inline script)
 */
function getHtml(webview: vscode.Webview): string {
  const csp = `default-src 'none'; style-src 'unsafe-inline' ${webview.cspSource}; script-src 'unsafe-inline' ${webview.cspSource}; connect-src ws: wss: https:`;
  return [
    '<!DOCTYPE html>',
    '<html><head>',
    '<meta charset="UTF-8">',
    `<meta http-equiv="Content-Security-Policy" content="${csp}">`,
    '</head><body style="font-family:Segoe UI,Arial,system-ui;margin:12px;">',
    '<h3>WebRTC Collab — Perfect</h3>',
    '<div>',
    ' Signaling WS: <input id="ws" value="ws://localhost:8080" style="width:260px;">',
    ' Room: <input id="room" value="room1" style="width:160px;">',
    '</div><br>',
    '<button id="host">Host</button> <button id="join">Join</button> <button id="disc" disabled>Disconnect</button>',
    '<pre id="log" style="margin-top:10px;background:#111;color:#eee;padding:8px;border-radius:6px;height:180px;overflow:auto;"></pre>',
    '<script>',
    // inline script — keep exact content for safety
`const vscode = acquireVsCodeApi();
const logEl = document.getElementById('log');
function log(m){ logEl.textContent += m + "\\n"; logEl.scrollTop = logEl.scrollHeight; }
let pc=null,dc=null,socket=null,role=null,room=null,pending=[];

function setState(s){ 
  document.getElementById('host').disabled = s !== 'idle';
  document.getElementById('join').disabled = s !== 'idle';
  document.getElementById('disc').disabled = (s === 'idle');
}

function reset(){ 
  try{ dc && dc.close(); }catch{} 
  try{ pc && pc.close(); }catch{} 
  try{ socket && socket.close(); }catch{} 
  pc = dc = socket = null; pending = []; setState('idle'); log('Disconnected'); 
}

async function ensurePC(){
  pc = new RTCPeerConnection({ iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] });
  pc.onicecandidate = e => {
    if (e.candidate && socket && room) socket.send(JSON.stringify({ type: 'candidate', room, candidate: e.candidate }));
  };
  pc.onconnectionstatechange = () => {
    log('RTC: ' + pc.connectionState);
    if (pc.connectionState === 'connected') setState('connected');
    if (['failed','disconnected','closed'].includes(pc.connectionState)) reset();
  };
}

function wire(ch){
  dc = ch;
  dc.onopen = () => { 
    log('DataChannel open'); 
    // notify extension (so it can forward the full document to the peer)
    try { vscode.postMessage({ type: 'dc-open' }); } catch {}
  };
  dc.onmessage = e => { 
    try { const m = JSON.parse(e.data); vscode.postMessage(m); } catch {}
  };
  dc.onclose = () => log('DC closed');
}

async function start(r){
  // r = 'host' or 'join'
  reset();
  role = r;
  room = document.getElementById('room').value.trim();
  log("Role = " + role);
  await ensurePC();
  if (r === 'host') {
    wire(pc.createDataChannel('code'));
  } else {
    pc.ondatachannel = e => wire(e.channel);
  }

  socket = new WebSocket(document.getElementById('ws').value);
  socket.onopen = async () => {
    log('WS connected');
    socket.send(JSON.stringify({ type: (r === 'host') ? 'create' : 'join', room }));
    if (r === 'host') {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      socket.send(JSON.stringify({ type: 'offer', room, sdp: offer }));
      log('Offer sent');
    }
  };

  socket.onmessage = async (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'offer' && role === 'join') {
      await pc.setRemoteDescription(m.sdp);
      const ans = await pc.createAnswer();
      await pc.setLocalDescription(ans);
      socket.send(JSON.stringify({ type: 'answer', room, sdp: ans }));
      log('Answer sent');
      for (const c of pending) { try { await pc.addIceCandidate(c); } catch {} }
      pending = [];
    } else if (m.type === 'answer' && role === 'host') {
      await pc.setRemoteDescription(m.sdp);
      log('Answer applied');
      for (const c of pending) { try { await pc.addIceCandidate(c); } catch {} }
      pending = [];
    } else if (m.type === 'candidate') {
      if (!pc.remoteDescription) {
        pending.push(m.candidate);
      } else {
        try { await pc.addIceCandidate(m.candidate); } catch {}
      }
    }
  };

  socket.onclose = () => log('WS closed');
  socket.onerror = () => log('WS error');
}

// wire the UI buttons
document.getElementById('host').onclick = () => start('host');
document.getElementById('join').onclick = () => start('join');
document.getElementById('disc').onclick = reset;

// messages FROM extension -> forward to peer (over DC)
window.addEventListener('message', (ev) => {
  if (dc && dc.readyState === 'open') {
    try { dc.send(JSON.stringify(ev.data)); } catch {}
  }
});

setState('idle'); log('Ready.');`,
    '</script></body></html>'
  ].join('');
}

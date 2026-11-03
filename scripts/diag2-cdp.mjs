// Диагностика #2: HTML документа, консоль, сетевые ошибки при reload
import { writeFileSync } from 'node:fs';

const port = process.argv[2] || '9222';

async function main() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await res.json();
  const page = targets.find(t => t.type === 'page' && /music\.youtube\.com/.test(t.url));
  if (!page) { console.log('NO_TARGET'); process.exit(2); }

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res2, rej) => { ws.onopen = res2; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  const events = [];
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); return; }
    if (msg.method) {
      if (msg.method === 'Runtime.consoleAPICalled' || msg.method === 'Log.entryAdded') {
        const e = msg.params;
        const text = e.entry ? `${e.entry.level}: ${e.entry.text} ${e.entry.url || ''}` : `${e.type}: ${(e.args || []).map(a => a.value ?? a.description ?? '').join(' ').slice(0, 300)}`;
        events.push(`[console] ${text.slice(0, 400)}`);
      } else if (msg.method === 'Network.loadingFailed') {
        events.push(`[net-fail] ${msg.params.errorText} ${msg.params.blockedReason || ''} (cancelled=${msg.params.canceled})`);
      } else if (msg.method === 'Network.responseReceived') {
        const r = msg.params.response;
        if (msg.params.type === 'Document') events.push(`[doc] ${r.status} ${r.url} mime=${r.mimeType} size=${r.encodedDataLength}`);
      }
    }
  };
  const send = (method, params = {}) => new Promise((r) => {
    const mid = ++id;
    pending.set(mid, r);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value ?? JSON.stringify(r.result?.error ?? r.result).slice(0, 400);
  };

  const before = await evalJs(`(() => ({
    contentType: document.contentType,
    charset: document.characterSet,
    htmlHead: document.documentElement.outerHTML.slice(0, 500),
    nav: performance.getEntriesByType('navigation').map(n => ({ name: n.name, size: n.transferSize, type: n.type })),
  }))()`);
  console.log('BEFORE_RELOAD:', JSON.stringify(before, null, 2));

  await send('Network.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Page.enable');
  events.length = 0;
  await send('Page.reload', { ignoreCache: true });
  await new Promise(r => setTimeout(r, 12000));

  const after = await evalJs(`(() => ({
    title: document.title,
    hasApp: !!document.querySelector('ytmusic-app'),
    bodyLen: (document.body && document.body.innerHTML || '').length,
    snippet: (document.body && document.body.innerText || '').slice(0, 200),
  }))()`);
  console.log('AFTER_RELOAD:', JSON.stringify(after, null, 2));
  console.log('--- EVENTS (uniq, first 40) ---');
  console.log([...new Set(events)].slice(0, 40).join('\n'));

  try {
    const shot = await Promise.race([
      send('Page.captureScreenshot', { format: 'png', fromSurface: true }),
      new Promise(r => setTimeout(() => r(null), 8000)),
    ]);
    if (shot?.result?.data) {
      writeFileSync('D:/youtube/ytm-desktop/diag-shot2.png', Buffer.from(shot.result.data, 'base64'));
      console.log('SCREENSHOT_SAVED');
    } else console.log('screenshot skipped/hung');
  } catch { console.log('screenshot failed'); }
  ws.close();
  process.exit(0);
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });

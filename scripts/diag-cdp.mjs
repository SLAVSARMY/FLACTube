// Диагностика через CDP: состояние страницы + скриншот
import { writeFileSync } from 'node:fs';

const port = process.argv[2] || '9222';

async function main() {
  // ждём появления отладочного порта
  let targets = null;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      targets = await res.json();
      break;
    } catch { await new Promise(r => setTimeout(r, 1000)); }
  }
  if (!targets) { console.log('CDP_PORT_NOT_UP'); process.exit(2); }

  const page = targets.find(t => t.type === 'page' && /music\.youtube\.com/.test(t.url))
    || targets.find(t => t.type === 'page');
  if (!page) { console.log('NO_PAGE_TARGET'); console.log(targets.map(t => `${t.type} ${t.url}`).join('\n')); process.exit(2); }
  console.log('TARGET:', page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

  let id = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    return r.result?.result?.value ?? r.result?.error ?? null;
  };

  const info = await evalJs(`(() => ({
    href: location.href,
    readyState: document.readyState,
    title: document.title,
    hasApp: !!document.querySelector('ytmusic-app'),
    hasPlayerBar: !!document.querySelector('ytmusic-player-bar'),
    hasFlacBtn: !!document.getElementById('ytm-dl-flac'),
    hasBridge: typeof window.ytmDesktop,
    videoPresent: !!document.querySelector('video'),
    bodySnippet: (document.body && document.body.innerText || '').slice(0, 300),
  }))()`);
  console.log('PAGE_INFO:', JSON.stringify(info, null, 2));

  await send('Page.enable');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    writeFileSync(process.argv[3] || 'D:/youtube/ytm-desktop/diag-shot.png', Buffer.from(shot.result.data, 'base64'));
    console.log('SCREENSHOT_SAVED');
  } else {
    console.log('NO_SCREENSHOT', JSON.stringify(shot).slice(0, 200));
  }
  ws.close();
  process.exit(0);
}

main().catch(e => { console.error('DIAG_ERROR', e.message); process.exit(1); });

// Репродукция бага паузы в режиме takeover (трек из библиотеки)
import { writeFileSync } from 'node:fs';

const port = process.argv[2] || '9223';
const TRACK = process.argv[3] || 'drFq6OmBsFk';
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function findPage() {
  for (let i = 0; i < 30; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const targets = await res.json();
      const page = targets.find(t => t.type === 'page' && /music\.youtube\.com/.test(t.url));
      if (page) return page;
    } catch {}
    await sleep(1000);
  }
  return null;
}

const connect = (page) => new Promise((res, rej) => {
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  ws.onopen = () => res(ws);
  ws.onerror = rej;
});

async function main() {
  const page0 = await findPage();
  if (!page0) { console.log('NO_PAGE_TARGET'); process.exit(2); }
  let ws = await connect(page0);

  let id = 0;
  const pending = new Map();
  const onMsg = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  };
  ws.onmessage = onMsg;
  const send = (method, params = {}) => new Promise((res) => {
    const mid = ++id;
    pending.set(mid, res);
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
  const evalJs = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (r.result?.exceptionDetails) return { EXC: r.result.exceptionDetails.exception?.description || 'exc' };
    return r.result?.result?.value ?? null;
  };

  const sample = `(() => {
    const vs = [...document.querySelectorAll('video')];
    const a = document.getElementById('ytm-local-audio');
    const badge = document.getElementById('ytm-flac-badge');
    return {
      videos: vs.length,
      v0: vs[0] ? { paused: vs[0].paused, muted: vs[0].muted, t: +(vs[0].currentTime||0).toFixed(2) } : null,
      audio: a ? { paused: a.paused, muted: a.muted, t: +(a.currentTime||0).toFixed(2), hasSrc: !!(a.currentSrc||a.src) } : null,
      badge: badge ? badge.style.display : null,
      session: navigator.mediaSession ? navigator.mediaSession.playbackState : '?',
      barBtn: (() => { const b = document.querySelector('ytmusic-player-bar #play-pause-button'); return b ? b.getAttribute('aria-label') : null; })(),
    };
  })()`;

  console.log('NAVIGATING to track', TRACK);
  await send('Runtime.evaluate', { expression: `location.href = 'https://music.youtube.com/watch?v=${TRACK}'` });
  ws.close();
  await sleep(8000);
  const page1 = await findPage();
  ws = await connect(page1);
  ws.onmessage = onMsg;

  console.log('PAGE:', await evalJs('location.href'));

  // старт
  const startLabel = await evalJs(`(() => {
    const b = document.querySelector('ytmusic-play-button');
    if (b) { b.click(); return 'play-page-btn'; }
    const pb = document.querySelector('ytmusic-player-bar #play-pause-button');
    if (pb) { pb.click(); return 'bar-btn'; }
    return 'none';
  })()`);
  console.log('START_CLICKED:', startLabel);

  // ждём takeover: аудио играет, видео замьючено
  let takeover = false;
  for (let i = 0; i < 20; i++) {
    await sleep(500);
    const s = await evalJs(sample);
    if (s.audio && !s.audio.paused && s.v0 && s.v0.muted) { takeover = true; console.log(`+${(i+1)*500}ms TAKEOVER ENGAGED`, JSON.stringify(s)); break; }
    console.log(`+${(i+1)*500}ms`, JSON.stringify(s));
  }
  if (!takeover) console.log('NO_TAKEOVER_DETECTED (возможно нет файла или сайт не отдал id)');

  // пауза сайта
  console.log('--- site PAUSE click ---');
  await evalJs(`(() => { const b = document.querySelector('ytmusic-player-bar #play-pause-button'); if (b) { b.click(); return 1; } return 0; })()`);
  for (let i = 0; i < 20; i++) {
    await sleep(200);
    const r = await evalJs(sample);
    const a = (r && r.audio) || {};
    const v = (r && r.v0) || {};
    console.log(`pause +${(i+1)*200}ms v.paused=${v.paused} v.muted=${v.muted} v.t=${v.t} | a.paused=${a.paused} a.t=${a.t} | session=${r.session}`);
  }

  // повторный плей сайта
  console.log('--- site PLAY click ---');
  await evalJs(`(() => { const b = document.querySelector('ytmusic-player-bar #play-pause-button'); if (b) { b.click(); return 1; } return 0; })()`);
  for (let i = 0; i < 8; i++) {
    await sleep(250);
    const r = await evalJs(sample);
    const a = (r && r.audio) || {};
    const v = (r && r.v0) || {};
    console.log(`play +${(i+1)*250}ms v.paused=${v.paused} v.muted=${v.muted} v.t=${v.t} | a.paused=${a.paused} a.t=${a.t} | session=${r.session}`);
  }

  await send('Page.enable');
  const shot = await send('Page.captureScreenshot', { format: 'png' });
  if (shot.result?.data) {
    writeFileSync('D:/youtube/ytm-desktop/diag-pause.png', Buffer.from(shot.result.data, 'base64'));
    console.log('SCREENSHOT_SAVED');
  }
  ws.close();
  process.exit(0);
}

main().catch(e => { console.error('DIAG_ERROR', e.message); process.exit(1); });

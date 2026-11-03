// Диагностика #3: кнопки навигации + содержимое панели
const port = process.argv[2] || '9222';

async function main() {
  const res = await fetch(`http://127.0.0.1:${port}/json/list`);
  const targets = await res.json();
  const topbar = targets.find(t => t.type === 'page' && /topbar\.html/.test(t.url));
  const music = targets.find(t => t.type === 'page' && /music\.youtube\.com/.test(t.url));
  if (!topbar || !music) { console.log('TARGETS:', targets.map(t => t.url).join(' | ')); process.exit(2); }

  const connect = async (t) => {
    const ws = new WebSocket(t.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let id = 0; const pend = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } };
    return {
      eval: async (expression) => {
        const r = await new Promise((r2) => {
          const i = ++id;
          pend.set(i, r2);
          ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }));
        });
        return r.result?.result?.value ?? null;
      },
      close: () => ws.close(),
    };
  };

  const tb = await connect(topbar);
  const mu = await connect(music);

  // 1. панель: содержимое прикреплено?
  console.log('DRAWER_CHILDREN:', await mu.eval('document.getElementById("ytm-drawer") ? document.getElementById("ytm-drawer").children.length : -1'));
  console.log('DRAWER_HEAD_TEXT:', await mu.eval('(document.querySelector(".ytm-drawer-title")||{}).textContent || "NO_TITLE"'));

  // 2. топбар: navapi жив?
  console.log('NAVAPI_TYPE:', await tb.eval('typeof window.navapi'));
  console.log('RELOAD_DS:', await tb.eval('document.getElementById("reload").dataset.action'));

  // 3. тест HOME
  const urlBefore = await mu.eval('location.href');
  await tb.eval('window.navapi.action("home")');
  await new Promise(r => setTimeout(r, 5000));
  const urlAfter = await mu.eval('location.href');
  console.log('HOME_TEST:', JSON.stringify({ before: urlBefore.slice(0, 60), after: urlAfter.slice(0, 60), changed: urlAfter !== urlBefore }));

  // 4. тест RELOAD (маркер должен исчезнуть)
  await mu.eval('window.__marker = 42');
  await tb.eval('window.navapi.action("reload")');
  await new Promise(r => setTimeout(r, 7000));
  const marker = await mu.eval('window.__marker === 42');
  console.log('RELOAD_TEST:', marker === true ? 'FAILED (страница не перезагрузилась)' : 'OK (перезагрузилась)');

  // 5. состояние кнопок
  console.log('BTN_STATE:', JSON.stringify(await tb.eval('({ back: document.getElementById("back").disabled, fwd: document.getElementById("forward").disabled, url: document.getElementById("url").value.slice(0, 50) })')));

  tb.close(); mu.close();
  process.exit(0);
}

main().catch(e => { console.error('ERR', e.message); process.exit(1); });

// Автопроверка Google-логина в FLACTube через CDP (до пароля).
// Запуск: приложение должно работать с --remote-debugging-port=9222, затем:
//   node scripts/test-login-flow.mjs [email]
import { writeFileSync } from 'node:fs';

const port = '9222';
const EMAIL = process.argv[2] || '';
const LOGIN_URL = 'https://accounts.google.com/ServiceLogin?ltmpl=music&service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2Fsignin%3Faction_handle_signin%3Dtrue%26next%3Dhttps%253A%252F%252Fmusic.youtube.com%252F';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(ws, method, params = {}) {
  const id = ++cdp.id;
  ws.send(JSON.stringify({ id, method, params }));
  return await new Promise((res) => { cdp.pending.set(id, res); });
}
cdp.id = 0; cdp.pending = new Map();

async function main() {
  let targets = null;
  for (let i = 0; i < 20; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      targets = await res.json(); break;
    } catch { await sleep(1000); }
  }
  if (!targets) { console.log('CDP_PORT_NOT_UP'); process.exit(2); }

  const page = targets.find((t) => t.type === 'page' && /accounts\.google\.com|music\.youtube\.com/.test(t.url))
    || targets.find((t) => t.type === 'page');
  if (!page) { console.log('NO_PAGE_TARGET'); process.exit(2); }
  console.log('TARGET:', page.url);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && cdp.pending.has(m.id)) { cdp.pending.get(m.id)(m); cdp.pending.delete(m.id); }
  };

  const evalJs = async (expr) => {
    const r = await cdp(ws, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    return r.result && r.result.result && r.result.result.value;
  };

  // текущий UA страницы — что реально видит гугл в JS
  console.log('navigator.userAgent =', await evalJs('navigator.userAgent'));
  console.log('userAgentData =', await evalJs('String(navigator.userAgentData)'));

  // навигация на логин, если ещё не там
  if (!/accounts\.google\.com/.test(page.url)) {
    console.log('навигация на страницу входа...');
    await evalJs(`location.href = ${JSON.stringify(LOGIN_URL)}`);
    await sleep(6000);
  }

  // ждём поле email
  let emailBox = null;
  for (let i = 0; i < 15; i++) {
    emailBox = await evalJs(`(function(){
      const i = document.querySelector('input[type="email"]') || document.querySelector('#identifierId');
      return i ? 'FOUND' : '';
    })()`);
    if (emailBox) break;
    await sleep(1000);
  }
  if (!emailBox) {
    console.log('EMAIL_FIELD_NOT_FOUND — страница не дошла до ввода почты');
    console.log('заголовок:', await evalJs('document.title'));
    console.log('URL:', await evalJs('location.href'));
    const shot = await cdp(ws, 'Page.captureScreenshot', { format: 'jpeg', quality: 60 });
    if (shot.result && shot.result.data) writeFileSync('D:/youtube/login-test-shot.jpg', Buffer.from(shot.result.data, 'base64'));
    process.exit(3);
  }
  console.log('поле email найдено, вводим:', EMAIL);

  // вводим email настоящими событиями (гугловский React слушает input)
  await evalJs(`(function(){
    const i = document.querySelector('input[type="email"]') || document.querySelector('#identifierId');
    i.value = ${JSON.stringify(EMAIL)};
    i.dispatchEvent(new Event('input', { bubbles: true }));
    i.dispatchEvent(new Event('change', { bubbles: true }));
    return 'SET';
  })()`);
  await sleep(800);

  // жмём «Далее»
  const clicked = await evalJs(`(function(){
    const btn = [...document.querySelectorAll('button, div[role="button"]')].find(b => /next|далее|дальше/i.test(b.textContent + ' ' + (b.getAttribute('aria-label')||'')));
    if (btn) { btn.click(); return 'CLICKED: ' + btn.textContent.trim().slice(0,30); }
    return 'NO_BTN';
  })()`);
  console.log('кнопка:', clicked);

  // ждём вердикт: поле пароля = прошли, ошибка = блок
  for (let i = 0; i < 20; i++) {
    await sleep(1000);
    const state = await evalJs(`(function(){
      if (document.querySelector('input[type="password"]')) return 'PASSWORD_STEP';
      const t = document.body.innerText || '';
      if (/couldn't sign you in|не удалось войти|browser or app|небезопасн|couldn.t sign/i.test(t)) return 'BLOCKED: ' + t.slice(0, 200);
      if (/wrong password|неправильный пароль|2-step|двухэтап/i.test(t)) return 'PASSWORD_STEP';
      return '';
    })()`);
    if (state) {
      console.log('РЕЗУЛЬТАТ:', state);
      const shot = await cdp(ws, 'Page.captureScreenshot', { format: 'jpeg', quality: 60 });
      if (shot.result && shot.result.data) writeFileSync('D:/youtube/login-test-shot.jpg', Buffer.from(shot.result.data, 'base64'));
      console.log('скриншот: D:/youtube/login-test-shot.jpg');
      process.exit(state.startsWith('PASSWORD_STEP') ? 0 : 4);
    }
  }
  console.log('TIMEOUT: ни пароль, ни ошибка за 20 с');
  process.exit(5);
}

main().catch((e) => { console.error('ERR', e.message); process.exit(1); });

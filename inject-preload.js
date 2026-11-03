const { contextBridge, ipcRenderer } = require('electron');

// i18n: словарь запрашиваем у главного процесса синхронным IPC —
// sandboxed preload не может require локальные файлы.
// Язык: localStorage('ytm-lang') → иначе системный (считает main).
let t = (key, vars) => {
  let s = key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll('{' + k + '}', String(v));
  return s;
};
let ORDER = [];
let LABELS = {};
try {
  let ov = null;
  try { ov = localStorage.getItem('ytm-lang'); } catch {}
  const init = ipcRenderer.sendSync('i18n:init', ov);
  if (init && init.str) {
    const STR = init.str;
    const lang = init.lang;
    ORDER = init.order || [];
    LABELS = init.labels || {};
    t = (key, vars) => {
      let s = (STR[lang] && STR[lang][key]) ?? (STR.en && STR.en[key]) ?? key;
      if (vars) for (const [k, v] of Object.entries(vars)) s = s.replaceAll('{' + k + '}', String(v));
      return s;
    };
  }
} catch {}

// «Вы ещё слушаете?» / «Are you still there?» — автопропуск.
// Также «Video paused. Continue watching?» / «Воспроизведение приостановлено. Продолжить просмотр?» —
// та же анти-фоновая плашка, но с другим текстом и кнопкой «Yes»/«Да».
const STILL_RE = /(are you still|still (there|listening)|вы ещё|вы еще|всё ещё|все еще|continue watching|продолжить просмотр|video paused|воспроизведение приостановл|просмотр остановл|приостановл\w* просмотр)/i;
const KEEP_RE = /(keep listening|continue listening|keep playing|слушать дальше|продолжить слушать|да, слушать|остаться|continue watching|продолжить просмотр|^да$|^yes$)/i;
// Промо-диалоги Premium — автозакрытие.
const PROMO_RE = /(music premium|youtube premium|попробуйте бесплатно|оформить пробн|free trial|try \d)/i;
const DISMISS_RE = /(no,? ?thanks|not now|skip|позже|не сейчас|нет, спасибо|закрыть)/i;

const $ = (sel, root) => Array.from((root || document).querySelectorAll(sel));

// Trusted Types у YouTube запрещают innerHTML — строим DOM только так:
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

// SVG-иконки (Material) — строим через createElementNS: Trusted Types
// запрещают innerHTML, а программный SVG им не противоречит.
const ICONS = {
  download: 'M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z',
  close: 'M19 6.41 17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
  settings: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.61 3.61 0 0 1 8.4 12c0-1.98 1.62-3.6 3.6-3.6s3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
  search: 'M15.5 14h-.79l-.28-.27C15.41 12.59 16 11.11 16 9.5 16 5.91 13.09 3 9.5 3S3 5.91 3 9.5 5.91 16 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
  favorite: 'M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z',
  shuffle: 'M10.59 9.17 5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5zm.33 9.41-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z',
  key: 'M12.65 10C11.83 7.67 9.61 6 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6c2.61 0 4.83-1.67 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z',
  queue_music: 'M15 6H3v2h12V6zm0 4H3v2h12v-2zM3 16h8v-2H3v2zm14-10v8.18c-.31-.11-.65-.18-1-.18-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3V10h3V6h-5z',
  album: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-12.5c-2.49 0-4.5 2.01-4.5 4.5s2.01 4.5 4.5 4.5 4.5-2.01 4.5-4.5-2.01-4.5-4.5-4.5zm0 5.5c-.55 0-1-.45-1-1s.45-1 1-1 1 .45 1 1-.45 1-1 1z',
  music_note: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z',
  play_arrow: 'M8 5v14l11-7z',
  pause: 'M6 19h4V5H6v14zm8-14v14h4V5h-4z',
  skip_previous: 'M6 6h2v12H6zm3.5 6 8.5 6V6z',
  skip_next: 'M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z',
  chevron_right: 'M10 6 8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
  chevron_left: 'M15.41 7.41 14 6l-6 6 6 6 1.41-1.41L10.83 12z',
  folder: 'M10 4H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z',
  refresh: 'M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08c-.82 2.33-3.04 4-5.65 4-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
  content_copy: 'M16 1H4c-1.1 0-2 .9-2 2v14h2V3h12V1zm3 4H8c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h11c1.1 0 2-.9 2-2V7c0-1.1-.9-2-2-2zm0 16H8V7h11v14z',
  check_circle: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
  error: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z',
};

// Реквизиты поддержки автора
const DONATE_WALLET = 'TGZN8xLTZX2rCtDptwjEjQM737E29UVWuU'; // USDT TRC20

function icon(name, size) {
  const NS = 'http://www.w3.org/2000/svg';
  const s = document.createElementNS(NS, 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', size || 18);
  s.setAttribute('height', size || 18);
  s.setAttribute('fill', 'currentColor');
  s.setAttribute('aria-hidden', 'true');
  s.classList.add('ytm-ic');
  const p = document.createElementNS(NS, 'path');
  p.setAttribute('d', ICONS[name] || '');
  s.append(p);
  return s;
}

// ── Пользовательские JSON-плагины ───────────────────────────────────────────
// Основной процесс шлёт 'plugins-changed' при старте и после «Обновить».
let pluginRules = null;
let pluginDismiss = [];  // {match, click} — автозакрытие диалогов
let pluginStyle = null;
const pluginTicks = [];  // api.onTick() из js-плагинов, дёргаются в общем тике

const safeRe = (src) => { try { return new RegExp(src, 'i'); } catch { return null; } };

function applyPlugins(p) {
  pluginRules = p || null;
  pluginDismiss = ((p && p.dismiss) || [])
    .map((r) => ({ match: safeRe(r.match), click: safeRe(r.click) }))
    .filter((r) => r.match && r.click);
  pluginTicks.length = 0;
  if (pluginStyle && pluginStyle.isConnected) pluginStyle.remove();
  pluginStyle = null;
  if (!p) return;
  if (p.css || (p.hide || []).length) {
    pluginStyle = el('style');
    pluginStyle.id = 'ytm-plugins-css';
    pluginStyle.textContent = (p.css || '') + (p.hide || []).map((s) => `\n${s}{display:none!important}`).join('');
    (document.head || document.documentElement).appendChild(pluginStyle);
  }
  // js-плагины: изолированный мир страницы (DOM общий, node нет).
  // api: тосты, скачивание трека, панель, onTick-хук. Падение одного
  // плагина не роняет остальные.
  (p.js || []).forEach((plug, i) => {
    try {
      const api = {
        name: plug.name || 'plugin-' + (i + 1),
        toast,
        download: (fmt) => ipcRenderer.send('download-current', fmt === 'copy' ? 'copy' : 'flac'),
        toggleDrawer,
        ipc: ipcRenderer,
        onTick: (fn) => { if (typeof fn === 'function') pluginTicks.push(fn); },
      };
      new Function('api', plug.code)(api);
    } catch (err) {
      console.warn('[ytm plugin]', plug.name, err);
    }
  });
}

function applyPluginRemovals() {
  const sels = pluginRules && pluginRules.remove;
  if (!sels || !sels.length) return;
  for (const s of sels) {
    try { for (const n of document.querySelectorAll(s)) n.remove(); } catch {}
  }
}

function runPluginTicks() {
  for (const fn of pluginTicks) { try { fn(); } catch {} }
}

ipcRenderer.on('plugins-changed', (_e, p) => { try { applyPlugins(p); } catch (err) { console.warn('[ytm plugins]', err); } });

function resumeIfPaused() {
  const v = document.querySelector('video');
  if (v && v.paused && v.src) { try { v.play(); } catch {} }
}

// Кнопка сайта «Start playback» в узких окнах уезжает в левый верхний угол —
// возвращаем её в центр области плеера (только перемещаем, не кликаем).
const SP_TEXT_RE = /^(start playback|начать воспроизведение|начать прослушивание)/i;
function fixStartPlayback() {
  const page = document.querySelector('ytmusic-player-page');
  if (!page) return;
  const pr = page.getBoundingClientRect();
  if (!pr.width) return;
  for (const b of page.querySelectorAll('tp-yt-paper-button, yt-button-shape button, button, [role="button"]')) {
    const t = (b.getAttribute('aria-label') || b.textContent || '').trim();
    if (!t || !SP_TEXT_RE.test(t)) continue;
    const r = b.getBoundingClientRect();
    if (r.width && r.height && r.y < pr.y + pr.height * 0.25) {
      b.style.position = 'fixed';
      b.style.left = Math.round(pr.x + pr.width / 2 - r.width / 2) + 'px';
      b.style.top = Math.round(pr.y + pr.height / 2 - r.height / 2) + 'px';
      b.style.zIndex = '10';
    }
  }
}

function patchDialogs() {
  const dialogs = [...$('tp-yt-paper-dialog'), ...$('ytmusic-you-there-dialog'), ...$('ytd-popup-container > *')];
  for (const d of dialogs) {
    const label = (d.getAttribute && d.getAttribute('aria-label')) || '';
    const text = ((d.textContent || '') + ' ' + label).slice(0, 600);
    if (STILL_RE.test(text)) {
      for (const b of $('button, tp-yt-paper-button, yt-button-shape button, [role="button"]', d)) {
        if (KEEP_RE.test((b.textContent || '').trim())) {
          b.click();
          setTimeout(resumeIfPaused, 150);
          setTimeout(resumeIfPaused, 800);
          break;
        }
      }
    }
    // autoDismiss из JSON-плагинов
    for (const r of pluginDismiss) {
      if (!r.match.test(text)) continue;
      for (const b of $('button, tp-yt-paper-button, yt-button-shape button, [role="button"]', d)) {
        if (r.click.test(b.textContent || '')) { b.click(); break; }
      }
    }
  }
}

function dismissPromos() {
  for (const d of $('tp-yt-paper-dialog')) {
    const text = (d.textContent || '').slice(0, 600);
    if (STILL_RE.test(text) || !PROMO_RE.test(text)) continue;
    for (const b of $('button, tp-yt-paper-button, yt-button-shape button, [role="button"]', d)) {
      if (DISMISS_RE.test(b.textContent || '')) { b.click(); break; }
    }
  }
  for (const n of $('ytmusic-mealbar-promo-renderer, .ytp-ad-message-container')) n.remove();
  // оверлеи рекламы прячем, но оставляем в DOM — по ним определяем, что играет реклама
  for (const s of $('.ytp-ad-player-overlay')) s.style.display = 'none';
  for (const s of $('.ytp-ad-skip-button, .ytp-ad-skip-button-modern')) { try { s.click(); } catch {} }
}

// ── Тосты (M3 snackbar: SVG-иконка + текст, без эмодзи) ─────────────────────
let toastTimer = null;
const TOAST_IC = { check: ['#2E7D46', 'check_circle'], error: ['#B3261E', 'error'], download: ['#5B5B5B', 'download'] };
function toast(msg, ms, ic) {
  let box = document.getElementById('ytm-toast');
  if (!box) {
    box = el('div');
    box.id = 'ytm-toast';
    box.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%) translateY(12px) scale(.97);bottom:92px;z-index:2147483647;background:#E9E9E9;color:#262626;padding:12px 18px;border-radius:14px;font:500 13.5px/1.4 "Segoe UI",Roboto,Arial,sans-serif;letter-spacing:.1px;box-shadow:0 3px 5px -1px rgba(0,0,0,.2),0 6px 10px rgba(0,0,0,.14),0 1px 3px rgba(0,0,0,.3);opacity:0;transition:opacity .25s ease,transform .35s cubic-bezier(.2,0,0,1);pointer-events:none;max-width:62vw;display:flex;align-items:center;gap:10px;white-space:nowrap';
    const icSpan = el('span', 'ytm-toast-ic');
    icSpan.style.cssText = 'display:flex;flex:none';
    const txt = el('span', 'ytm-toast-txt');
    txt.style.cssText = 'overflow:hidden;text-overflow:ellipsis';
    box.append(icSpan, txt);
    (document.body || document.documentElement).appendChild(box);
  }
  const icSpan = box.querySelector('.ytm-toast-ic');
  icSpan.replaceChildren();
  if (ic && TOAST_IC[ic]) {
    const [color, name] = TOAST_IC[ic];
    const sv = icon(name, 16);
    sv.style.color = color;
    icSpan.append(sv);
  }
  box.querySelector('.ytm-toast-txt').textContent = msg;
  box.style.opacity = '1';
  box.style.transform = 'translateX(-50%) translateY(0) scale(1)';
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    box.style.opacity = '0';
    box.style.transform = 'translateX(-50%) translateY(12px) scale(.97)';
  }, ms || 3200);
}

// ── Стили интерфейса ────────────────────────────────────────────────────────
const CSS = `
/* ── Material 3, тёмная схема (сид-цвет — красный YT Music) ─────────────── */
:root {
  --ytm-primary: #DADADA;
  --ytm-on-primary: #1C1C1C;
  --ytm-primary-container: #0C0C0C;
  --ytm-on-primary-container: #EDEDED;
  --ytm-accent-black: #0C0C0C;
  --ytm-accent-black-hover: #1F1F1F;
  --ytm-on-accent-black: #EDEDED;
  --ytm-secondary-container: #3D3D3D;
  --ytm-on-secondary-container: #EDEDED;
  --ytm-error: #F28B82;
  --ytm-success: #8BD89C;
  --ytm-on-surface: #EDEDED;
  --ytm-on-surface-variant: #B3B3B3;
  --ytm-outline: #9E9E9E;
  --ytm-outline-variant: #4A4A4A;
  --ytm-surface-container-low: #1C1C1C;
  --ytm-surface-container: #212121;
  --ytm-surface-container-high: #2B2B2B;
  --ytm-surface-container-highest: #363636;
  --ytm-ease: cubic-bezier(.2,0,0,1);
  --ytm-font: "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
.ytm-ic { display:block; flex:none }
/* Ресет рамок для всех наших элементов: без него flex-basis:100% + padding
   раздувает панели ленты шире drawer (правый край срезало) */
.ytm-drawer, .ytm-drawer *, .ytm-fabs, .ytm-fab, .ytm-handle, .ytm-scfab,
.ytm-flac-badge, .ytm-qlib, .ytm-qlib *, #ytm-toast, #ytm-toast * { box-sizing:border-box }
@keyframes ytmJobIn { from { opacity:0; transform:translateY(10px) } to { opacity:1; transform:none } }
@keyframes ytmSpin { to { transform:rotate(360deg) } }

/* Extended FAB над плеером */
.ytm-fabs { position:fixed; right:16px; bottom:96px; display:flex; gap:10px; z-index:2147483645 }
.ytm-fabs.ytm-hide { display:none }
.ytm-fab { height:48px; padding:0 20px; border-radius:24px; border:none;
  background:var(--ytm-surface-container-high); color:var(--ytm-on-surface);
  font:600 13.5px var(--ytm-font); letter-spacing:.2px; cursor:pointer;
  display:inline-flex; align-items:center; gap:9px;
  box-shadow:0 1px 3px rgba(0,0,0,.4), 0 4px 12px rgba(0,0,0,.3);
  transition:box-shadow .2s var(--ytm-ease), transform .2s var(--ytm-ease), background-color .18s }
.ytm-fab:hover { transform:translateY(-2px); background:var(--ytm-surface-container-highest);
  box-shadow:0 2px 6px rgba(0,0,0,.4), 0 10px 28px rgba(0,0,0,.35) }
.ytm-fab:active { transform:translateY(0) }
.ytm-fab.flac { background:var(--ytm-accent-black); color:var(--ytm-on-accent-black); border:1px solid rgba(255,255,255,.16) }
.ytm-fab.flac:hover { background:var(--ytm-accent-black-hover); box-shadow:0 2px 6px rgba(0,0,0,.4), 0 12px 30px rgba(0,0,0,.4) }

/* Язычок на правом краю */
.ytm-handle { position:fixed; right:0; bottom:158px; width:34px; height:62px; border-radius:17px 0 0 17px;
  background:var(--ytm-surface-container-high); border:none; color:var(--ytm-on-surface-variant); cursor:pointer;
  z-index:2147483645; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:3px;
  box-shadow:-4px 0 14px rgba(0,0,0,.35);
  transition:right .45s var(--ytm-ease), background-color .18s, color .18s }
.ytm-handle:hover { background:var(--ytm-surface-container-highest); color:var(--ytm-on-surface) }
.ytm-handle.open { right:396px; box-shadow:none }
.ytm-handle-count { min-width:18px; height:18px; border-radius:9px; background:var(--ytm-accent-black);
  color:var(--ytm-on-accent-black); border:1px solid rgba(255,255,255,.22);
  font:700 10px/17px var(--ytm-font); text-align:center; padding:0 5px; display:none }

/* Панель загрузок — modal side sheet */
.ytm-drawer { position:fixed; top:0; right:0; height:100%; width:396px; max-width:94vw;
  background:var(--ytm-surface-container-low);
  border-radius:16px 0 0 16px; box-shadow:-12px 0 36px rgba(0,0,0,.5);
  transform:translateX(108%); transition:transform .42s var(--ytm-ease);
  z-index:2147483646; display:flex; flex-direction:column; color:var(--ytm-on-surface);
  font:400 13px/1.5 var(--ytm-font) }
.ytm-drawer.open { transform:translateX(0) }
.ytm-drawer::before { content:''; position:absolute; top:0; bottom:0; right:100%; width:100vw;
  background:rgba(0,0,0,.42); opacity:0; transition:opacity .42s var(--ytm-ease); pointer-events:none }
.ytm-drawer.open::before { opacity:1 }
.ytm-drawer-head { display:flex; align-items:center; gap:4px; padding:16px 12px 12px 18px }
.ytm-drawer-title { display:flex; align-items:center; gap:10px; flex:1;
  font:600 16px var(--ytm-font); letter-spacing:.1px; color:var(--ytm-on-surface) }
.ytm-drawer-title .ytm-ic { color:var(--ytm-primary) }
.ytm-iconbtn { width:36px; height:36px; border-radius:50%; border:none; background:transparent;
  color:var(--ytm-on-surface-variant); display:inline-flex; align-items:center; justify-content:center;
  cursor:pointer; transition:background-color .18s, color .18s; flex:none }
.ytm-iconbtn:hover { background:rgba(255,255,255,.07); color:var(--ytm-on-surface) }
.ytm-iconbtn:active { background:rgba(255,255,255,.12) }

.ytm-actions { display:flex; gap:8px; padding:2px 16px 14px }
.ytm-actions .ytm-btn.primary { flex:1 }
.ytm-btn { height:38px; border-radius:19px; border:none; background:var(--ytm-secondary-container);
  color:var(--ytm-on-secondary-container); font:500 13px var(--ytm-font); letter-spacing:.15px;
  cursor:pointer; padding:0 16px; white-space:nowrap; display:inline-flex; align-items:center; justify-content:center; gap:7px;
  transition:box-shadow .18s var(--ytm-ease), background-color .18s, filter .18s }
.ytm-btn:hover { filter:brightness(1.1); box-shadow:0 1px 2px rgba(0,0,0,.3), 0 2px 6px rgba(0,0,0,.22) }
.ytm-btn:active { filter:brightness(.95); box-shadow:none }
.ytm-btn.primary { background:var(--ytm-accent-black); color:var(--ytm-on-accent-black);
  border:1px solid rgba(255,255,255,.16); font-weight:600 }
.ytm-btn.primary:hover { background:var(--ytm-accent-black-hover); box-shadow:0 2px 4px rgba(0,0,0,.35), 0 5px 12px rgba(0,0,0,.25) }
.ytm-btn:disabled { opacity:.4; cursor:default; filter:none; box-shadow:none }
.ytm-btn.icon { width:38px; padding:0 }
/* Настройки — плавно выкатываются, как панель в Telegram:
   grid-rows 0fr→1fr + каскад строк с задержками */
@keyframes ytmFadeUp { from { opacity:0; transform:translateY(8px) } to { opacity:1; transform:none } }
.ytm-settings { display:grid; grid-template-rows:0fr; opacity:0; transform:translateY(-8px);
  transition:grid-template-rows .45s var(--ytm-ease), opacity .3s ease, transform .45s var(--ytm-ease) }
.ytm-settings.open { grid-template-rows:1fr; opacity:1; transform:none }
.ytm-settings-inner { overflow:hidden; min-height:0; display:flex; flex-direction:column; gap:9px;
  margin:0 16px; border-top:1px solid rgba(255,255,255,.08); padding:0; transition:padding .45s var(--ytm-ease) }
.ytm-settings.open .ytm-settings-inner { padding:12px 0 14px }
.ytm-settings.open .ytm-settings-inner > * { animation:ytmFadeUp .34s var(--ytm-ease) both }
.ytm-settings.open .ytm-settings-inner > :nth-child(1) { animation-delay:.04s }
.ytm-settings.open .ytm-settings-inner > :nth-child(2) { animation-delay:.08s }
.ytm-settings.open .ytm-settings-inner > :nth-child(3) { animation-delay:.12s }
.ytm-settings.open .ytm-settings-inner > :nth-child(4) { animation-delay:.16s }
.ytm-settings.open .ytm-settings-inner > :nth-child(5) { animation-delay:.2s }
.ytm-settings.open .ytm-settings-inner > :nth-child(6) { animation-delay:.24s }
.ytm-settings.open .ytm-settings-inner > :nth-child(7) { animation-delay:.28s }
.ytm-settings.open .ytm-settings-inner > :nth-child(8) { animation-delay:.32s }
.ytm-row { display:flex; gap:8px; align-items:center }
.ytm-dir { flex:1; min-width:0; display:flex; align-items:center; gap:6px; color:var(--ytm-on-surface-variant) }
.ytm-dir .ytm-dim { flex:1; overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.ytm-input { flex:1; min-width:0; height:36px; background:transparent; border:1px solid var(--ytm-outline-variant);
  border-radius:10px; padding:0 12px; color:var(--ytm-on-surface); font:400 12.5px var(--ytm-font); outline:none;
  transition:border-color .18s, box-shadow .18s }
.ytm-input::placeholder { color:rgba(179,179,179,.55) }
.ytm-input:hover { border-color:var(--ytm-outline) }
.ytm-input:focus { border-color:var(--ytm-primary); box-shadow:inset 0 0 0 1px var(--ytm-primary) }
.ytm-select { height:36px; background:var(--ytm-surface-container-highest); color:var(--ytm-on-surface);
  border:1px solid var(--ytm-outline-variant); border-radius:10px; padding:0 8px;
  font:500 12.5px var(--ytm-font); outline:none; cursor:pointer; transition:border-color .18s }
.ytm-select:hover { border-color:var(--ytm-outline) }
.ytm-select:focus { border-color:var(--ytm-primary) }
.ytm-select option { background:var(--ytm-surface-container); color:var(--ytm-on-surface) }
.ytm-dim { color:var(--ytm-on-surface-variant); font-size:11.5px; line-height:1.5 }

/* Вкладки — segmented control со скользящим «бегунком» (как в TG) */
.ytm-tabs { position:relative; display:flex; margin:0 16px 12px; padding:3px;
  border:1px solid var(--ytm-outline-variant); border-radius:21px }
.ytm-tabs-thumb { position:absolute; top:3px; bottom:3px; left:0; width:118px;
  border-radius:18px; background:var(--ytm-secondary-container);
  transition:transform .22s cubic-bezier(.3,.1,.25,1); will-change:transform }
.ytm-tab { position:relative; z-index:1; flex:1; height:36px; display:inline-flex; align-items:center; justify-content:center; gap:6px;
  border:none; background:transparent; color:var(--ytm-on-surface-variant); font:500 12.5px var(--ytm-font); letter-spacing:.1px;
  cursor:pointer; white-space:nowrap; padding:0 6px; border-radius:18px; transition:background-color .18s, color .2s }
.ytm-tab:hover { background:rgba(255,255,255,.06) }
.ytm-tab.active { color:var(--ytm-on-secondary-container); font-weight:600 }

/* Контент вкладок — лента из трёх панелей, скользит влево/вправо как в TG.
   Короткая резкая анимация: долгий «хвост» ease выглядит как застревание */
.ytm-body { flex:1; overflow:hidden; padding:2px 0 0 }
.ytm-views { display:flex; height:100%; transition:transform .22s cubic-bezier(.3,.1,.25,1); will-change:transform }
.ytm-view { flex:0 0 100%; min-width:0; height:100%; overflow-y:auto; padding:2px 14px 20px;
  opacity:.45; transition:opacity .22s ease;
  scrollbar-width:thin; scrollbar-color:var(--ytm-outline-variant) transparent }
.ytm-view.active { opacity:1 }
.ytm-view::-webkit-scrollbar { width:10px }
.ytm-view::-webkit-scrollbar-thumb { background:var(--ytm-outline-variant); border-radius:5px;
  border:3px solid transparent; background-clip:padding-box }
.ytm-empty { display:flex; flex-direction:column; align-items:center; text-align:center; margin-top:56px; line-height:1.6 }
.ytm-empty-ic { width:76px; height:76px; border-radius:50%; background:var(--ytm-surface-container-high);
  color:var(--ytm-on-surface-variant); display:flex; align-items:center; justify-content:center; margin-bottom:18px }
.ytm-empty-title { font:600 14px var(--ytm-font); color:var(--ytm-on-surface); margin-bottom:6px }
.ytm-empty-hint { font:400 12.5px var(--ytm-font); color:var(--ytm-on-surface-variant) }
.ytm-empty-hint b { color:var(--ytm-on-surface); font-weight:600 }
.ytm-kbd { background:var(--ytm-surface-container-highest); border-radius:6px; padding:1px 7px;
  font:600 11px var(--ytm-font); color:var(--ytm-on-surface) }

/* Карточка загрузки — filled card + linear progress */
.ytm-job { background:var(--ytm-surface-container-high); border-radius:14px; padding:12px 10px 13px 14px;
  margin-bottom:10px; animation:ytmJobIn .3s var(--ytm-ease) }
.ytm-job-top { display:flex; align-items:center; gap:8px }
.ytm-badge { font:600 10px var(--ytm-font); letter-spacing:.6px; padding:4px 8px; border-radius:7px;
  background:var(--ytm-surface-container-highest); color:var(--ytm-on-surface-variant); flex:none }
.ytm-badge.flac { background:var(--ytm-accent-black); color:var(--ytm-on-accent-black); border:1px solid rgba(255,255,255,.2) }
.ytm-job-title { flex:1; min-width:0; font:500 13px var(--ytm-font); color:var(--ytm-on-surface);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.ytm-job-x { width:28px; height:28px; border-radius:50%; border:none; background:transparent;
  color:var(--ytm-on-surface-variant); display:inline-flex; align-items:center; justify-content:center;
  cursor:pointer; flex:none; transition:background-color .15s, color .15s }
.ytm-job-x:hover { background:rgba(255,255,255,.1); color:var(--ytm-on-surface) }
.ytm-bar { height:4px; border-radius:2px; background:rgba(0,0,0,.45); margin:10px 0 8px; overflow:hidden }
.ytm-fill { height:100%; width:0; border-radius:2px; background:var(--ytm-primary); transition:width .4s var(--ytm-ease) }
.ytm-fill.ok { background:var(--ytm-success) }
.ytm-fill.err { background:var(--ytm-error) }
.ytm-meta { color:var(--ytm-on-surface-variant); font-size:11.5px; line-height:1.45; word-break:break-all }

/* Списки (SoundCloud / библиотека) */
.ytm-sc-row, .ytm-lib-row { display:flex; align-items:center; gap:10px; padding:9px 10px; border-radius:14px;
  background:transparent; margin-bottom:2px; transition:background-color .15s }
.ytm-sc-row:hover, .ytm-lib-row:hover { background:rgba(255,255,255,.06) }
.ytm-sc-row.playing, .ytm-lib-row.playing { background:var(--ytm-secondary-container) }
.ytm-sc-main { flex:1; min-width:0 }
.ytm-sc-title { font:500 13px var(--ytm-font); color:var(--ytm-on-surface);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.ytm-sc-sub { color:var(--ytm-on-surface-variant); font-size:11.5px; margin-top:2px;
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.ytm-sc-row.playing .ytm-sc-title, .ytm-lib-row.playing .ytm-sc-title { color:var(--ytm-on-secondary-container) }
.ytm-sc-row.playing .ytm-sc-sub, .ytm-lib-row.playing .ytm-sc-sub { color:rgba(237,237,237,.75) }
.ytm-libbtn { width:34px; height:34px; border-radius:50%; border:none; background:var(--ytm-surface-container-highest);
  color:var(--ytm-on-surface); display:inline-flex; align-items:center; justify-content:center;
  cursor:pointer; flex:none; transition:background-color .18s, transform .15s, filter .18s }
.ytm-libbtn:hover { filter:brightness(1.3) }
.ytm-libbtn:active { transform:scale(.94) }
.ytm-libbtn.play { background:var(--ytm-accent-black); color:var(--ytm-on-accent-black); border:1px solid rgba(255,255,255,.18) }
.ytm-libbtn .ytm-ic-pause { display:none }
.ytm-libbtn.on .ytm-ic-pause { display:block }
.ytm-libbtn.on .ytm-ic-play { display:none }
.ytm-libbtn.play:hover { filter:brightness(1.15) }
.ytm-libbtn.busy .ytm-ic { display:none }
.ytm-libbtn.busy::after { content:''; width:14px; height:14px; border-radius:50%;
  border:2px solid rgba(237,237,237,.3); border-top-color:currentColor; animation:ytmSpin .8s linear infinite }
.ytm-status { color:var(--ytm-on-surface-variant); font-size:12px; line-height:1.5; padding:8px 4px }
.ytm-statusrow { display:flex; align-items:center; gap:8px }
.ytm-statusrow .ytm-ic { color:var(--ytm-primary) }
.ytm-spin { width:14px; height:14px; border-radius:50%; border:2px solid var(--ytm-outline-variant);
  border-top-color:var(--ytm-on-surface); animation:ytmSpin .8s linear infinite; flex:none; display:none }

/* Оверлей-плеер библиотеки поверх бара сайта */
.ytm-bo { background:var(--ytm-surface-container); font-family:var(--ytm-font);
  box-shadow:0 -4px 18px rgba(0,0,0,.5) }
.ytm-bo-cover { width:48px; height:48px; border-radius:10px; flex:none;
  background:var(--ytm-accent-black); color:var(--ytm-on-accent-black); border:1px solid rgba(255,255,255,.14);
  display:flex; align-items:center; justify-content:center }
.ytm-bo-title { font:600 13px var(--ytm-font); color:var(--ytm-on-surface);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.ytm-bo-sub { font:400 11.5px var(--ytm-font); color:var(--ytm-on-surface-variant);
  overflow:hidden; text-overflow:ellipsis; white-space:nowrap }
.ytm-bo-cur, .ytm-bo-dur { font:500 11.5px var(--ytm-font); font-variant-numeric:tabular-nums;
  color:var(--ytm-on-surface-variant); flex:none }
.ytm-bo-btn { width:38px; height:38px; border-radius:50%; border:none; background:transparent;
  color:var(--ytm-on-surface); display:inline-flex; align-items:center; justify-content:center;
  cursor:pointer; flex:none; transition:background-color .18s }
.ytm-bo-btn:hover { background:rgba(255,255,255,.07) }
.ytm-bo-btn:active { background:rgba(255,255,255,.12) }
.ytm-bo-play { width:44px; height:44px; background:var(--ytm-accent-black); color:var(--ytm-on-accent-black);
  border:1px solid rgba(255,255,255,.18) }
.ytm-bo-play:hover { background:var(--ytm-accent-black-hover) }
.ytm-bo-play .ytm-ic-play { display:none }
.ytm-bo-play .ytm-ic-pause { display:block }
.ytm-bo-play.paused .ytm-ic-play { display:block }
.ytm-bo-play.paused .ytm-ic-pause { display:none }
.ytm-bo-seekwrap { flex:1; height:20px; display:flex; align-items:center; cursor:pointer; min-width:100px }
.ytm-bo-seek { width:100%; height:4px; border-radius:2px; background:rgba(0,0,0,.5); overflow:hidden; transition:height .15s }
.ytm-bo-seekwrap:hover .ytm-bo-seek { height:6px }
.ytm-bo-fill { height:100%; width:0; background:var(--ytm-primary); border-radius:2px }

/* Значок локального FLAC */
.ytm-flac-badge { background:var(--ytm-surface-container-high); border:none; color:var(--ytm-on-surface);
  padding:9px 16px; border-radius:999px; font:500 12.5px var(--ytm-font); letter-spacing:.1px;
  display:flex; align-items:center; gap:8px }

/* Секция библиотеки в очереди UP NEXT */
.ytm-qlib { padding:16px 16px 32px; border-top:1px solid rgba(255,255,255,.12); margin-top:10px }
.ytm-qlib-head { display:flex; align-items:center; gap:8px; font:600 11px var(--ytm-font);
  color:var(--ytm-on-surface-variant); letter-spacing:.9px; text-transform:uppercase; margin-bottom:10px }
.ytm-qlib-head .ytm-ic { color:var(--ytm-primary) }

/* Кнопка на страницах треков SoundCloud — extended FAB */
.ytm-scfab { position:fixed; right:16px; bottom:80px; z-index:2147483647; height:52px; padding:0 22px;
  border-radius:26px; border:1px solid rgba(255,255,255,.16);
  background:var(--ytm-accent-black); color:var(--ytm-on-accent-black);
  font:600 13.5px var(--ytm-font); letter-spacing:.2px; cursor:pointer;
  box-shadow:0 2px 6px rgba(0,0,0,.4), 0 8px 24px rgba(0,0,0,.35);
  display:none; align-items:center; gap:9px;
  transition:box-shadow .2s var(--ytm-ease), transform .2s var(--ytm-ease), background-color .18s }
.ytm-scfab:hover { transform:translateY(-2px); background:var(--ytm-accent-black-hover);
  box-shadow:0 2px 6px rgba(0,0,0,.4), 0 12px 30px rgba(0,0,0,.4) }
.ytm-scfab:active { transform:translateY(0) }

/* Фокус-индикаторы (доступность) */
.ytm-drawer button:focus-visible, .ytm-fab:focus-visible, .ytm-scfab:focus-visible,
.ytm-bo-btn:focus-visible, .ytm-handle:focus-visible {
  outline:2px solid var(--ytm-primary); outline-offset:2px }
`;

// ── Кнопки FLAC / RAW над плеером ───────────────────────────────────────────
let fabsWrap = null;

// Показываем кнопки, только когда в плеере уже есть трек — до этого они лишние
function refreshFabs() {
  if (!fabsWrap) return;
  const md = navigator.mediaSession && navigator.mediaSession.metadata;
  const has = (md && md.title) || document.querySelector('ytmusic-player-bar a[href*="watch?v="]');
  fabsWrap.classList.toggle('ytm-hide', !has);
}

function injectFabs() {
  if (document.getElementById('ytm-fabs')) return;
  const wrap = el('div', 'ytm-fabs ytm-hide');
  wrap.id = 'ytm-fabs';
  fabsWrap = wrap;
  const flac = el('button', 'ytm-fab flac');
  flac.append(icon('download'), el('span', null, 'FLAC'));
  flac.title = t('flacFabT');
  const raw = el('button', 'ytm-fab');
  raw.append(icon('album'), el('span', null, 'RAW'));
  raw.title = t('rawFabT');
  flac.onclick = (e) => { e.stopPropagation(); ipcRenderer.send('download-current', 'flac'); };
  raw.onclick = (e) => { e.stopPropagation(); ipcRenderer.send('download-current', 'copy'); };
  wrap.append(flac, raw);
  (document.body || document.documentElement).appendChild(wrap);
}

// ── Выезжающая панель загрузок ──────────────────────────────────────────────
const drawerState = { bins: { ytdlp: false, ffmpeg: false } };
let setDrawerOpen = null;

function buildDrawer() {
  if (document.getElementById('ytm-drawer')) return;

  const style = el('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  // Язычок на правом краю
  const handle = el('button', 'ytm-handle');
  handle.id = 'ytm-handle';
  handle.title = 'Панель загрузок (F10)';
  // язычок: закрыто — иконка загрузки, открыто — «свернуть» (стрелка перевёрнута влево)
  const hDl = icon('download', 16);
  const hChev = icon('chevron_right', 16);
  hChev.style.display = 'none';
  const hCount = el('span', 'ytm-handle-count');
  handle.append(hDl, hChev, hCount);

  // Панель
  const d = el('div', 'ytm-drawer');
  d.id = 'ytm-drawer';

  const head = el('div', 'ytm-drawer-head');
  const dTitle = el('span', 'ytm-drawer-title');
  dTitle.append(icon('download', 20), el('span', null, t('title')));
  head.append(dTitle);
  const setBtn = el('button', 'ytm-iconbtn');
  setBtn.append(icon('settings', 17));
  setBtn.title = t('settings');
  const closeBtn = el('button', 'ytm-iconbtn');
  closeBtn.append(icon('close', 17));
  closeBtn.title = t('close');
  head.append(setBtn, closeBtn);

  const actions = el('div', 'ytm-actions');
  const flacBtn = el('button', 'ytm-btn primary');
  flacBtn.append(icon('download', 16), el('span', null, t('flacCurrent')));
  const rawBtn = el('button', 'ytm-btn');
  rawBtn.append(icon('album', 16), el('span', null, t('raw')));
  actions.append(flacBtn, rawBtn);

  const settings = el('div', 'ytm-settings');
  const sInner = el('div', 'ytm-settings-inner');
  settings.append(sInner);
  const dirRow = el('div', 'ytm-row');
  const dirVal = el('span', 'ytm-dir');
  const dirValText = el('span', 'ytm-dim', '');
  dirVal.append(icon('folder', 14), dirValText);
  const dirBtn = el('button', 'ytm-btn', t('browse'));
  dirBtn.title = t('browse');
  const openBtn = el('button', 'ytm-btn', t('open'));
  openBtn.title = t('open');
  dirRow.append(dirVal, dirBtn, openBtn);

  const proxyRow = el('div', 'ytm-row');
  const proxyInput = el('input', 'ytm-input');
  proxyInput.placeholder = t('proxyPh');
  proxyInput.spellcheck = false;
  const proxyBtn = el('button', 'ytm-btn', t('ok'));
  proxyRow.append(proxyInput, proxyBtn);
  const proxyHint = el('div', 'ytm-dim', '');

  // SpotiFLAC-режим: tidal-api-совместимый lossless-источник (по ISRC)
  const llRow = el('div', 'ytm-row');
  const llInput = el('input', 'ytm-input');
  llInput.placeholder = 'lossless: https://tidal-api-сервер/ (по ISRC)';
  llInput.spellcheck = false;
  const llBtn = el('button', 'ytm-btn', t('ok'));
  llRow.append(llInput, llBtn);
  const llHint = el('div', 'ytm-dim', '');
  llHint.textContent = 'источник true-lossless (16/24-bit). Пусто = FLAC из лучшего потока';

  const binsRow = el('div', 'ytm-row');
  const binsLabel = el('span', 'ytm-dim', '');
  binsLabel.style.cssText = 'flex:1';
  const binsBtn = el('button', 'ytm-btn');
  binsBtn.append(icon('download', 15), el('span', null, t('binsGet')));
  binsBtn.style.display = 'none';
  binsRow.append(binsLabel, binsBtn);

  const plugRow = el('div', 'ytm-row');
  const plugLabel = el('span', 'ytm-dim', t('plugins'));
  plugLabel.style.cssText = 'flex:1';
  const plugReloadBtn = el('button', 'ytm-btn icon');
  plugReloadBtn.append(icon('refresh', 14));
  plugReloadBtn.title = t('pluginsReloadT');
  const plugFolderBtn = el('button', 'ytm-btn');
  plugFolderBtn.append(icon('folder', 14), el('span', null, t('pluginsOpenT').split(' ')[0]));
  plugFolderBtn.title = t('pluginsOpenT');
  plugRow.append(plugLabel, plugReloadBtn, plugFolderBtn);

  // Поддержать автора — USDT TRC20, клик копирует адрес
  const donateRow = el('div', 'ytm-row');
  const donateLabel = el('span', 'ytm-dim', t('donate'));
  donateLabel.style.cssText = 'flex:1';
  const donateBtn = el('button', 'ytm-btn');
  const donateAddr = el('span', null, DONATE_WALLET.slice(0, 4) + '…' + DONATE_WALLET.slice(-4));
  donateBtn.append(icon('content_copy', 14), donateAddr);
  donateBtn.title = DONATE_WALLET;
  donateRow.append(donateLabel, donateBtn);

  // Язык интерфейса — по умолчанию системный
  const langRow = el('div', 'ytm-row');
  const langLabel = el('span', 'ytm-dim', t('lang'));
  langLabel.style.cssText = 'flex:1';
  const langSel = el('select', 'ytm-select');
  const optAuto = el('option', null, t('langAuto'));
  optAuto.value = 'auto';
  langSel.append(optAuto);
  for (const code of ORDER) {
    const o = el('option', null, LABELS[code]);
    o.value = code;
    langSel.append(o);
  }
  try { langSel.value = localStorage.getItem('ytm-lang') || 'auto'; } catch { langSel.value = 'auto'; }
  langSel.onchange = () => {
    try { localStorage.setItem('ytm-lang', langSel.value); } catch {}
    location.reload();
  };
  langRow.append(langLabel, langSel);

  sInner.append(dirRow, proxyRow, proxyHint, llRow, llHint, binsRow, plugRow, donateRow, langRow);

  donateBtn.onclick = async () => {
    const ok = () => toast(t('copied'), null, 'check');
    try {
      await navigator.clipboard.writeText(DONATE_WALLET);
      ok();
    } catch {
      // запасной путь, если clipboard API зарезан политиками страницы
      const ta = el('textarea');
      ta.value = DONATE_WALLET;
      ta.style.cssText = 'position:fixed;opacity:0';
      (document.body || document.documentElement).append(ta);
      ta.select();
      try { document.execCommand('copy'); ok(); }
      catch { toast(t('copyFail'), null, 'error'); }
      ta.remove();
    }
  };

  const tabs = el('div', 'ytm-tabs');
  const tabsThumb = el('span', 'ytm-tabs-thumb');
  const tabJobs = el('button', 'ytm-tab active');
  tabJobs.append(icon('download', 15), el('span', null, t('tabJobs')));
  const tabSearch = el('button', 'ytm-tab');
  tabSearch.append(icon('search', 15), el('span', null, t('tabSc')));
  const tabLib = el('button', 'ytm-tab');
  tabLib.append(icon('queue_music', 15), el('span', null, t('tabLib')));
  tabs.append(tabsThumb, tabJobs, tabSearch, tabLib);

  const body = el('div', 'ytm-body');
  const viewsWrap = el('div', 'ytm-views');
  const viewJobs = el('div', 'ytm-view active');
  const viewSearch = el('div', 'ytm-view');
  const viewLib = el('div', 'ytm-view');
  viewsWrap.append(viewJobs, viewSearch, viewLib);
  body.append(viewsWrap);

  // — поиск SoundCloud —
  const searchRow = el('div', 'ytm-row');
  const searchInput = el('input', 'ytm-input');
  searchInput.placeholder = t('searchPh');
  searchInput.spellcheck = false;
  const searchBtn = el('button', 'ytm-btn icon');
  searchBtn.append(icon('search', 16));
  searchRow.append(searchInput, searchBtn);
  const importRow = el('div', 'ytm-row');
  const importInput = el('input', 'ytm-input');
  importInput.placeholder = t('importPh');
  importInput.spellcheck = false;
  const importBtn = el('button', 'ytm-btn icon');
  importBtn.append(icon('favorite', 16));
  importBtn.title = t('importT');
  importRow.append(importInput, importBtn);
  const searchStatus = el('div', 'ytm-status ytm-statusrow');
  const searchSpin = el('span', 'ytm-spin');
  const searchText = el('span', null, t('searchHint'));
  searchStatus.append(searchSpin, searchText);
  const setSearchStatus = (text, spin) => {
    searchText.textContent = text;
    searchSpin.style.display = spin ? 'inline-block' : 'none';
  };
  const dlAll = el('button', 'ytm-btn');
  dlAll.append(icon('download', 15), el('span', null, t('dlAll')));
  dlAll.style.display = 'none';
  const searchResults = el('div');
  viewSearch.append(searchRow, importRow, searchStatus, dlAll, searchResults);

  // — общая библиотека —
  const libTools = el('div', 'ytm-row');
  const shuffleBtn = el('button', 'ytm-btn');
  shuffleBtn.append(icon('shuffle', 15), el('span', null, t('shuffle')));
  shuffleBtn.title = t('shuffleT');
  const loginBtn = el('button', 'ytm-btn');
  loginBtn.append(icon('key', 15), el('span', null, t('scLogin')));
  loginBtn.title = t('scLoginT');
  libTools.append(shuffleBtn, loginBtn);
  const libStatus = el('div', 'ytm-status ytm-statusrow');
  const libStText = el('span', null, '');
  libStatus.append(icon('queue_music', 14), libStText);
  const libList = el('div');
  viewLib.append(libTools, libStatus, libList);

  const empty = el('div', 'ytm-empty');
  const emptyIc = el('div', 'ytm-empty-ic');
  emptyIc.append(icon('download', 30));
  const emptyTitle = el('div', 'ytm-empty-title', t('emptyTitle'));
  const emptyHint = el('div', 'ytm-empty-hint', t('emptyHint', { key: 'F9' }));
  empty.append(emptyIc, emptyTitle, emptyHint);

  d.append(head, actions, tabs, settings, body);
  (document.body || document.documentElement).append(handle, d);
  // ширины вкладок известны только после вставки — выставляем бегунок точно
  requestAnimationFrame(() => { try { moveThumb(0); } catch {} });

  setDrawerOpen = (v) => {
    const open = v == null ? !d.classList.contains('open') : v;
    d.classList.toggle('open', open);
    handle.classList.toggle('open', open);
    hDl.style.display = open ? 'none' : 'block';
    hChev.style.display = open ? 'block' : 'none';
    if (open) refreshState();
  };

  handle.onclick = () => setDrawerOpen();
  closeBtn.onclick = () => setDrawerOpen(false);
  setBtn.onclick = () => settings.classList.toggle('open');
  flacBtn.onclick = () => ipcRenderer.send('download-current', 'flac');
  rawBtn.onclick = () => ipcRenderer.send('download-current', 'copy');
  dirBtn.onclick = async () => { dirValText.textContent = await ipcRenderer.invoke('panel:choose-outdir'); };
  openBtn.onclick = () => ipcRenderer.invoke('panel:open-folder');
  proxyBtn.onclick = async () => {
    const v = await ipcRenderer.invoke('panel:set-proxy', proxyInput.value);
    proxyHint.textContent = v ? t('proxyOn') + v : t('proxyOff');
  };
  llBtn.onclick = async () => {
    const v = await ipcRenderer.invoke('panel:set-lossless', llInput.value).catch((e) => { llHint.textContent = '❌ ' + ((e && e.message) || 'ошибка'); return null; });
    if (v != null) llHint.textContent = v ? '✅ lossless-источник: ' + v : 'источник сброшен — FLAC из потока';
  };
  binsBtn.onclick = async () => {
    binsBtn.disabled = true;
    binsLabel.style.display = '';
    binsLabel.textContent = t('binsGetting');
    await ipcRenderer.invoke('panel:install-binaries');
    binsBtn.disabled = false;
    refreshState();
  };

  ipcRenderer.on('jobs-changed', (_e, jobs) => renderJobs(jobs));
  ipcRenderer.on('bin-progress', (_e, msg) => { binsLabel.style.display = ''; binsLabel.textContent = msg; });

  // — вкладки — бегунок позиционируем по фактическим координатам вкладки:
  // субпиксельно и независимо от длины меток в любом языке
  const tabEls = [tabJobs, tabSearch, tabLib];
  function moveThumb(idx) {
    const seg = tabEls[idx].getBoundingClientRect();
    const box = tabs.getBoundingClientRect();
    // left:0 у бегунка — от padding-box (внутри border), компенсируем границу
    const border = parseFloat(getComputedStyle(tabs).borderLeftWidth) || 0;
    tabsThumb.style.width = seg.width + 'px';
    tabsThumb.style.transform = 'translateX(' + (seg.left - box.left - border) + 'px)';
  }
  function showView(name) {
    const idx = name === 'jobs' ? 0 : name === 'search' ? 1 : 2;
    // и бегунок, и сама лента панелей едут синхронно
    viewsWrap.style.transform = `translateX(-${idx * 100}%)`;
    moveThumb(idx);
    tabJobs.classList.toggle('active', name === 'jobs');
    tabSearch.classList.toggle('active', name === 'search');
    tabLib.classList.toggle('active', name === 'lib');
    viewJobs.classList.toggle('active', name === 'jobs');
    viewSearch.classList.toggle('active', name === 'search');
    viewLib.classList.toggle('active', name === 'lib');
    if (name === 'lib') loadLibrary();
    if (name === 'search') setTimeout(() => searchInput.focus(), 120);
  }
  tabJobs.onclick = () => showView('jobs');
  tabSearch.onclick = () => showView('search');
  tabLib.onclick = () => showView('lib');

  // — поиск SoundCloud —
  // Номер последнего поиска: результаты старого вылетают, если запрос перебили
  // новым — иначе поздний ответ затирал свежие результаты
  let searchSeq = 0;
  async function doSearch() {
    const q = searchInput.value.trim();
    if (!q) return;
    const mySeq = ++searchSeq;
    searchStatus.style.display = 'flex';
    setSearchStatus(t('searching'), true);
    try {
      const results = await ipcRenderer.invoke('sc-search', q);
      if (mySeq !== searchSeq) return; // поиск уже перебили более новым
      lastResults = results;
      renderSearchResults(results);
      if (!results.length) setSearchStatus(t('noResults'), false);
      else searchStatus.style.display = 'none';
    } catch (e) {
      if (mySeq !== searchSeq) return;
      setSearchStatus((e && e.message) || t('searchErr'), false);
    }
  }
  searchBtn.onclick = doSearch;
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') doSearch(); });

  let lastResults = [];
  let importSeq = 0;
  importBtn.onclick = async () => {
    const url = importInput.value.trim();
    if (!url) return;
    const mySeq = ++importSeq;
    searchStatus.style.display = 'flex';
    setSearchStatus(t('importing'), true);
    try {
      const results = await ipcRenderer.invoke('sc-import', url);
      if (mySeq !== importSeq) return;
      lastResults = results;
      renderSearchResults(results);
      dlAll.style.display = results.length ? '' : 'none';
      if (!results.length) setSearchStatus(t('importPrivate'), false);
      else searchStatus.style.display = 'none';
    } catch (e) {
      if (mySeq !== importSeq) return;
      setSearchStatus((e && e.message) || t('importErr'), false);
    }
  };
  dlAll.onclick = async () => {
    for (const r of lastResults) {
      await ipcRenderer.invoke('download-url', { source: 'soundcloud', id: r.id, title: r.title, pageUrl: r.url }, 'flac').catch(() => null);
    }
    toast(t('dlAll'), null, 'download');
  };
  shuffleBtn.onclick = () => {
    shuffleOn = !shuffleOn;
    shuffleBtn.classList.toggle('primary', shuffleOn);
    if (libMode) libMode.order = null;
    toast(t('shuffle'), null, shuffleOn ? 'check' : undefined);
  };
  loginBtn.onclick = () => ipcRenderer.invoke('sc-open-login');

  function renderSearchResults(results) {
    searchResults.replaceChildren();
    for (const r of results) {
      const row = el('div', 'ytm-sc-row');
      const main = el('div', 'ytm-sc-main');
      main.append(el('div', 'ytm-sc-title', r.title));
      main.append(el('div', 'ytm-sc-sub', (r.uploader ? r.uploader + ' · ' : '') + mmss(r.duration)));
      const dl = el('button', 'ytm-libbtn play');
      dl.append(icon('download', 15));
      dl.title = 'Скачать FLAC в общую библиотеку';
      dl.onclick = async () => {
        dl.disabled = true;
        dl.classList.add('busy');
        await ipcRenderer.invoke('download-url', { source: 'soundcloud', id: r.id, title: r.title, pageUrl: r.url }, 'flac').catch(() => null);
        dl.classList.remove('busy');
        dl.disabled = false;
      };
      row.append(main, dl);
      searchResults.append(row);
    }
  }

  // — библиотека —
  async function loadLibrary() {
    libCache = await ipcRenderer.invoke('library:list').catch(() => []);
    libStText.textContent = libCache.length
      ? t('libN', { n: libCache.length })
      : t('libEmpty');
    libList.replaceChildren();
    for (const trk of libCache) {
      const row = el('div', 'ytm-lib-row');
      row.dataset.id = trk.id;
      const btn = el('button', 'ytm-libbtn');
      btn.title = t('listen');
      const bp = icon('play_arrow', 15);
      bp.classList.add('ytm-ic-play');
      const bq = icon('pause', 15);
      bq.classList.add('ytm-ic-pause');
      btn.append(bp, bq);
      btn.onclick = () => libToggle(trk.id);
      const main = el('div', 'ytm-sc-main');
      main.append(el('div', 'ytm-sc-title', trk.title));
      main.append(el('div', 'ytm-sc-sub', [trk.info, (trk.size / 1048576).toFixed(1) + ' ' + t('mb')].filter(Boolean).join(' · ')));
      row.append(btn, main);
      if (trk.source === 'soundcloud' || trk.source === 'youtube') {
        const sb = el('span', 'ytm-badge' + (trk.source === 'soundcloud' ? ' flac' : ''), trk.source === 'soundcloud' ? 'SC' : 'YT');
        row.append(sb);
      }
      const del = el('button', 'ytm-job-x', '🗑');
      del.title = 'Удалить из библиотеки';
      del.style.fontSize = '14px';
      del.onclick = async () => {
        if (libMode && libMode.list[libMode.index] && libMode.list[libMode.index].id === trk.id) libStop();
        const n = await ipcRenderer.invoke('library:delete', trk.id).catch(() => 0);
        if (n) { toast('🗑 Удалено из библиотеки'); loadLibrary(); }
      };
      row.append(del);
      libList.append(row);
    }
    updateLibPlayButtons();
  }

  plugFolderBtn.onclick = () => ipcRenderer.invoke('plugins:open-folder');
  plugReloadBtn.onclick = async () => {
    plugReloadBtn.disabled = true;
    const i = await ipcRenderer.invoke('plugins:reload').catch(() => null);
    plugReloadBtn.disabled = false;
    if (i) toast(i.ok ? t('mbPlugOk', { n: i.ok, m: i.count }) : t('mbPlugNone'), null, i.ok ? 'check' : 'error');
  };

  function refreshState() {
    ipcRenderer.invoke('panel:state').then((st) => {
      drawerState.bins = st.bins;
      dirValText.textContent = st.outDir;
      if (st.proxy && !proxyInput.value) proxyInput.value = st.proxy;
      if (st.losslessApi !== undefined && !llInput.value) llInput.value = st.losslessApi || '';
      renderBins();
      renderJobs(st.jobs);
    }).catch(() => {});
    ipcRenderer.invoke('plugins:state').then((st) => {
      const ok = st.list.filter((p) => p.ok).length;
      plugLabel.textContent = !st.list.length ? t('pluginsEmpty')
        : ok < st.list.length ? t('pluginsPartial', { n: ok, m: st.list.length }) : t('pluginsOk', { n: st.list.length });
      plugLabel.title = st.dir + (st.list.length ? '\n' + st.list.map((p) => (p.ok ? '' : '⚠ ') + p.name).join('\n') : '');
    }).catch(() => {});
    loadLibrary();
  }

  function renderBins() {
    const ok = drawerState.bins.ytdlp && drawerState.bins.ffmpeg;
    // строка статуса нужна только когда что-то не так — исправное состояние не засоряем
    binsLabel.style.display = ok ? 'none' : '';
    binsLabel.textContent = ok ? ''
      : '⚠ ' + t('binsMissing') + [!drawerState.bins.ytdlp && 'yt-dlp', !drawerState.bins.ffmpeg && 'ffmpeg'].filter(Boolean).join(', ');
    binsBtn.style.display = ok ? 'none' : '';
  }

  function badgeText(j) {
    if (j.status === 'done' || j.lossless) return j.lossless ? 'FLAC' : ((j.container || '').toUpperCase() || 'AUDIO');
    return j.format === 'flac' ? 'FLAC' : 'RAW';
  }

  const jobCards = new Map();

  function makeCard(j) {
    const card = el('div', 'ytm-job');
    const top = el('div', 'ytm-job-top');
    const badge = el('span', 'ytm-badge' + (j.lossless || j.format === 'flac' ? ' flac' : ''), badgeText(j));
    const title = el('span', 'ytm-job-title', j.title);
    title.title = j.title;
  const x = el('button', 'ytm-job-x');
  x.append(icon('close', 13));
  x.title = t('cancel');
    x.onclick = () => ipcRenderer.invoke('panel:cancel', j.id);
    top.append(badge, title, x);
    const bar = el('div', 'ytm-bar');
    const fill = el('div', 'ytm-fill');
    bar.append(fill);
    const meta = el('div', 'ytm-meta');
    card.append(top, bar, meta);
    return { card, badge, title, x, fill, meta };
  }

  function updateCard(c, j) {
    const badgeTxt = badgeText(j);
    const badgeCls = 'ytm-badge' + ((j.lossless || j.format === 'flac') && j.lossless !== false ? ' flac' : '');
    if (c.badge.textContent !== badgeTxt) { c.badge.textContent = badgeTxt; c.badge.className = badgeCls; }
    if (c.title.textContent !== j.title) { c.title.textContent = j.title; c.title.title = j.title; }
    const pct = j.status === 'done' ? 100 : (j.percent || 0);
    const w = pct + '%';
    if (c.fill.style.width !== w) c.fill.style.width = w;
    const fillCls = 'ytm-fill' + (j.status === 'done' ? ' ok' : j.status === 'error' ? ' err' : '');
    if (c.fill.className !== fillCls) c.fill.className = fillCls;
    let metaTxt;
    if (j.status === 'done' && j.file) metaTxt = t('stDone') + j.file;
    else if (j.status === 'error') metaTxt = '⚠ ' + j.error;
    else if (j.status === 'canceled') metaTxt = t('stCanceled');
    else {
      const st = { queued: t('stQueued'), downloading: t('stDl'), enriching: 'метаданные + ISRC…', converting: t('stConv') }[j.status] || j.status;
      metaTxt = j.status === 'downloading' && j.percent ? st + ' ' + Math.round(j.percent) + '%' : st;
    }
    if (c.meta.textContent !== metaTxt) c.meta.textContent = metaTxt;
    c.x.style.visibility = ['done', 'error', 'canceled'].includes(j.status) ? 'hidden' : 'visible';
  }

  function renderJobs(jobs) {
    const active = jobs.filter((j) => ['queued', 'downloading', 'enriching', 'converting'].includes(j.status)).length;
    hCount.textContent = active;
    hCount.style.display = active ? 'block' : 'none';

    // удаляем карточки исчезнувших задач
    const ids = new Set(jobs.map((j) => j.id));
    for (const [id, c] of [...jobCards]) {
      if (!ids.has(id)) { c.card.remove(); jobCards.delete(id); }
    }

    if (!jobs.length) {
      jobCards.clear();
      viewJobs.replaceChildren(empty);
      return;
    }
    if (empty.parentNode === viewJobs) empty.remove();
    // обновляем карточки на месте (без пересоздания DOM)
    for (const j of jobs) {
      let c = jobCards.get(j.id);
      if (!c) { c = makeCard(j); jobCards.set(j.id, c); updateCard(c, j); }
      else updateCard(c, j);
    }
    // переставляем DOM только если порядок реально изменился —
    // перемещение узла перезапускает CSS-анимацию (мерцание)
    const desired = jobs.map((j) => jobCards.get(j.id).card);
    const current = [...viewJobs.children].filter((ch) => ch.classList && ch.classList.contains('ytm-job'));
    const ordered = desired.length === current.length && desired.every((c, i) => c === current[i]);
    if (!ordered) desired.forEach((c) => viewJobs.append(c));
  }
}

function toggleDrawer() {
  buildDrawer();
  if (setDrawerOpen) setDrawerOpen();
}

// ── Локальный FLAC-плеер: подмена звука на скачанный файл ───────────────────
let localAudio = null;
let currentLocalId = null;
let takeover = false; // сейчас звучит локальный файл
const userDisabled = new Set(); // id, для которых юзер вернул ютубовское качество
let flacBadge = null;
let lastFlacPoll = 0;

// ── Локальная библиотека: собственный плеер ─────────────────────────────────
let libMode = null; // { list, index }

let libCache = [];

const mmss = (s) => {
  s = Math.max(0, Math.floor(s || 0));
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
};
let shuffleOn = false;

// Интеграция в плеер-бар сайта: оверлей поверх ytmusic-player-bar
let barOverlay = null;

function ensureBarOverlay() {
  if (barOverlay && barOverlay.isConnected) return barOverlay;
  barOverlay = el('div');
  barOverlay.id = 'ytm-bar-overlay';
  barOverlay.className = 'ytm-bo';
  barOverlay.style.cssText = 'position:fixed;z-index:2147483640;display:none;align-items:center;gap:10px;padding:0 18px';

  const cover = el('div', 'ytm-bo-cover');
  cover.append(icon('music_note', 22));

  const info = el('div');
  info.style.cssText = 'width:220px;flex:none;display:flex;flex-direction:column;gap:3px';
  const title = el('div', 'ytm-bo-title');
  const sub = el('div', 'ytm-bo-sub');
  info.append(title, sub);

  const mkBtn = (cls, title2, fn) => {
    const b = el('button', cls ? 'ytm-bo-btn ' + cls : 'ytm-bo-btn');
    b.title = title2;
    b.onclick = (e) => { e.stopPropagation(); fn(); };
    return b;
  };
  const prev = mkBtn('', t('prevT'), () => libNext(-1));
  prev.append(icon('skip_previous', 18));
  const play = mkBtn('ytm-bo-play', t('playT'), () => {
    const a = ensureAudio();
    if (a.paused) { a.play(); } else { a.pause(); }
  });
  const icPlay = icon('play_arrow', 20);
  icPlay.classList.add('ytm-ic-play');
  const icPause = icon('pause', 20);
  icPause.classList.add('ytm-ic-pause');
  play.append(icPlay, icPause);
  play.classList.add('paused');
  const next = mkBtn('', t('nextT'), () => libNext(1));
  next.append(icon('skip_next', 18));

  const cur = el('span', 'ytm-bo-cur', '0:00');

  const seek = el('div', 'ytm-bo-seekwrap');
  seek.title = t('seekT');
  const seekTrack = el('div', 'ytm-bo-seek');
  const seekFill = el('div', 'ytm-bo-fill');
  seekTrack.append(seekFill);
  seek.append(seekTrack);
  seek.onclick = (e) => {
    const r = seek.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    const a = ensureAudio();
    if (a.duration) { try { a.currentTime = ratio * a.duration; } catch {} }
  };

  const dur = el('span', 'ytm-bo-dur', '0:00');

  const vol = el('input');
  vol.type = 'range'; vol.min = 0; vol.max = 100; vol.value = 100;
  vol.title = t('volT');
  vol.style.cssText = 'width:96px;flex:none;accent-color:#DADADA;cursor:pointer';
  vol.oninput = () => { ensureAudio().volume = vol.value / 100; };

  const exit = mkBtn('', t('exitT'), () => libStop());
  exit.append(icon('close', 17));

  barOverlay.append(cover, info, prev, play, next, cur, seek, dur, vol, exit);
  (document.body || document.documentElement).appendChild(barOverlay);
  return barOverlay;
}

function placeBarOverlay() {
  if (!barOverlay || barOverlay.style.display !== 'flex') return;
  const bar = document.querySelector('ytmusic-player-bar');
  if (!bar) {
    // страницы без родного бара (SoundCloud): прижимаем к низу окна
    barOverlay.style.left = '0';
    barOverlay.style.top = '';
    barOverlay.style.bottom = '0';
    barOverlay.style.width = '100%';
    barOverlay.style.height = '64px';
    return;
  }
  const r = bar.getBoundingClientRect();
  if (r.height < 20) {
    // бар сайта ещё не развёрнут (ни один трек не включали) — прижимаем к низу окна,
    // иначе оверлей получает нулевую высоту и плеер «ломается»
    barOverlay.style.left = '0';
    barOverlay.style.top = '';
    barOverlay.style.bottom = '0';
    barOverlay.style.width = '100%';
    barOverlay.style.height = '72px';
    return;
  }
  barOverlay.style.left = r.left + 'px';
  barOverlay.style.top = r.top + 'px';
  barOverlay.style.bottom = '';
  barOverlay.style.width = r.width + 'px';
  barOverlay.style.height = r.height + 'px';
}

function updateBarSeek() {
  if (!libMode || !barOverlay || barOverlay.style.display !== 'flex') return;
  const a = localAudio;
  if (!a) return;
  const fill = barOverlay.querySelector('.ytm-bo-fill');
  const cur = barOverlay.querySelector('.ytm-bo-cur');
  const dur = barOverlay.querySelector('.ytm-bo-dur');
  const d = a.duration && isFinite(a.duration) ? a.duration : 0;
  fill.style.width = (d ? (a.currentTime / d) * 100 : 0) + '%';
  cur.textContent = mmss(a.currentTime);
  dur.textContent = mmss(d);
}

function setBarPlayIcon(paused) {
  if (!barOverlay) return;
  const b = barOverlay.querySelector('.ytm-bo-play');
  if (b) b.classList.toggle('paused', !!paused);
}

function renderLibPlayer() {
  if (!libMode) {
    if (barOverlay) barOverlay.style.display = 'none';
    return;
  }
  const entry = libMode.list[libMode.index];
  const ov = ensureBarOverlay();
  ov.querySelector('.ytm-bo-title').textContent = entry.title;
  ov.querySelector('.ytm-bo-sub').textContent =
    [entry.info, (entry.ext || '').toUpperCase(), (libMode.index + 1) + '/' + libMode.list.length].filter(Boolean).join(' · ');
  ov.style.display = 'flex';
  placeBarOverlay();
  updateBarSeek();
  // событие play могло прийти до создания оверлея — сверяем иконку с фактом
  if (localAudio) setBarPlayIcon(localAudio.paused);
}

async function libPlayById(id) {
  let list = libCache;
  if (!list || !list.length) {
    list = await ipcRenderer.invoke('library:list').catch(() => []);
    libCache = list;
  }
  const index = list.findIndex((x) => x.id === id);
  if (index < 0) return;
  if (takeover) stopTakeover();
  libMode = { list, index };
  const a = ensureAudio();
  const entry = list[index];
  if (a.src !== entry.url) a.src = entry.url;
  a.volume = 1;
  try { await a.play(); } catch {}
  const v = document.querySelector('video');
  if (v && !v.paused) { try { v.pause(); } catch {} }
  renderLibPlayer();
  markLibRow(id);
}

function libNext(dir) {
  if (!libMode) return;
  let i;
  if (shuffleOn) {
    if (!libMode.order || libMode.order.length !== libMode.list.length) {
      libMode.order = libMode.list.map((_, k) => k).sort(() => Math.random() - 0.5);
    }
    let p = libMode.order.indexOf(libMode.index) + dir;
    if (p >= libMode.order.length) { libStop(); return; }
    if (p < 0) p = libMode.order.length - 1;
    i = libMode.order[p];
  } else {
    i = libMode.index + dir;
    if (i >= libMode.list.length) { libStop(); return; }
    if (i < 0) i = libMode.list.length - 1;
  }
  libPlayById(libMode.list[i].id);
}

function libStop() {
  libMode = null;
  if (localAudio) { try { localAudio.pause(); } catch {} }
  renderLibPlayer();
  markLibRow(null);
}

async function libToggle(id) {
  if (libMode && libMode.list[libMode.index] && libMode.list[libMode.index].id === id) {
    const a = ensureAudio();
    if (a.paused) { try { await a.play(); } catch {} } else { try { a.pause(); } catch {} }
    return;
  }
  await libPlayById(id);
}

// ▶/⏸ в списке библиотеки должны отражать фактическое состояние звука:
// играет трек из строки — ⏸, на паузе или другой трек — ▶
function updateLibPlayButtons() {
  const cur = libMode && libMode.list[libMode.index] ? libMode.list[libMode.index].id : null;
  const playing = !!(cur && localAudio && !localAudio.paused);
  document.querySelectorAll('.ytm-lib-row').forEach((r) => {
    const b = r.querySelector('.ytm-libbtn');
    if (b) b.classList.toggle('on', playing && r.dataset.id === cur);
  });
}

function markLibRow(id) {
  document.querySelectorAll('.ytm-lib-row').forEach((r) => {
    r.classList.toggle('playing', r.dataset.id === id);
  });
  updateLibPlayButtons();
}

function ensureAudio() {
  if (!localAudio) {
    localAudio = el('audio');
    localAudio.id = 'ytm-local-audio';
    localAudio.preload = 'auto';
    localAudio.addEventListener('ended', () => { if (libMode) libNext(1); });
    localAudio.addEventListener('timeupdate', () => { try { updateBarSeek(); } catch {} });
    localAudio.addEventListener('play', () => { try { setBarPlayIcon(false); updateLibPlayButtons(); } catch {} });
    localAudio.addEventListener('pause', () => { try { setBarPlayIcon(true); updateLibPlayButtons(); } catch {} });
    (document.body || document.documentElement).appendChild(localAudio);
  }
  return localAudio;
}

function setFlacBadge(text) {
  if (!text) { if (flacBadge) flacBadge.style.display = 'none'; return; }
  if (!flacBadge || !flacBadge.isConnected) {
    flacBadge = el('div');
    flacBadge.id = 'ytm-flac-badge';
    flacBadge.className = 'ytm-flac-badge';
    flacBadge.style.cssText = 'position:fixed;left:50%;transform:translateX(-50%);bottom:56px;z-index:2147483644;cursor:pointer;box-shadow:0 4px 14px rgba(0,0,0,.4)';
    const fbIc = icon('music_note', 14);
    fbIc.style.color = '#8BD89C';
    flacBadge.append(fbIc, el('span', null, text));
    flacBadge.title = 'Играет локальный FLAC. Клик — вернуть ютубовское качество';
    flacBadge.onclick = () => {
      if (currentLocalId) userDisabled.add(currentLocalId);
      stopTakeover();
      toast(t('qualityBack'));
    };
    (document.body || document.documentElement).appendChild(flacBadge);
  } else {
    flacBadge.lastChild.textContent = text;
  }
  flacBadge.style.display = 'flex';
}

function stopTakeover() {
  takeover = false;
  if (localAudio) { try { localAudio.pause(); } catch {} }
  const v = document.querySelector('video');
  if (v) v.muted = v.__ytmPrevMuted || false;
  setFlacBadge(null);
}

async function pollFlac() {
  const now = Date.now();
  if (now - lastFlacPoll < 800) return;
  lastFlacPoll = now;

  // режим библиотеки: наш плеер рулит (уходим, если юзер включил трек на сайте)
  if (libMode) {
    const vv = document.querySelector('video');
    if (vv && !vv.paused) libStop();
    return;
  }

  const v = document.querySelector('video');
  if (!v) return;

  // реклама — не перехватываем
  const adEl = document.querySelector('.ytp-ad-player-overlay');
  const isAd = !!(adEl && getComputedStyle(adEl).display !== 'none');

  let id = null;
  try { id = new URL(location.href).searchParams.get('v'); } catch {}
  if (!id) {
    const a = document.querySelector('ytmusic-player-bar a[href*="watch?v="]');
    if (a) { const m = a.href.match(/[?&]v=([\w-]{11})/); if (m) id = m[1]; }
  }

  if (id !== currentLocalId) {
    if (takeover) stopTakeover();
    currentLocalId = id;
  }
  if (!id || isAd || userDisabled.has(id)) {
    if (takeover) stopTakeover();
    return;
  }

  const a = ensureAudio();

  if (!takeover) {
    // есть ли скачанный файл для этого трека?
    const info = await ipcRenderer.invoke('library:check', id).catch(() => null);
    if (!info || !info.url) return;
    if (a.src !== info.url) { a.src = info.url; }
    a.volume = v.volume;
    try { a.currentTime = Math.max(0, v.currentTime || 0); } catch {}
    v.__ytmPrevMuted = v.muted;
    v.muted = true;
    try {
      await a.play();
      takeover = true;
      setFlacBadge(t('flacBadge'));
    } catch { v.muted = v.__ytmPrevMuted || false; }
    return;
  }

  // синхронизация: сайт управляет таймлайном, мы только звуком
  if (a.paused && !v.paused) {
    try { a.currentTime = Math.max(0, v.currentTime || 0); await a.play(); } catch {}
    v.muted = true;
  } else if (!a.paused && v.paused) {
    try { a.pause(); } catch {}
  } else if (!a.paused) {
    if (Math.abs(a.currentTime - v.currentTime) > 0.35) {
      try { a.currentTime = v.currentTime; } catch {}
    }
    if (a.volume !== v.volume) a.volume = v.volume;
    if (!v.muted) v.muted = true;
  }
}

let booted = false;
// ── Встройка библиотеки в очередь UP NEXT сайта ─────────────────────────────
let queueLibTimer = 0;

async function updateQueueLibrary(force) {
  const now = Date.now();
  if (!force && now - queueLibTimer < 3000) return;
  queueLibTimer = now;

  const contents = document.querySelector('ytmusic-player-queue #contents');
  if (!contents) return;

  if (!libCache.length) {
    libCache = await ipcRenderer.invoke('library:list').catch(() => []);
  }

  let sec = document.getElementById('ytm-queue-lib');
  if (!sec) {
    sec = el('div');
    sec.id = 'ytm-queue-lib';
    sec.className = 'ytm-qlib';
    const head = el('div', 'ytm-qlib-head');
    head.append(icon('queue_music', 15), el('span', null, t('qHeader')));
    sec.append(head);
    contents.append(sec);
  }

  const listEl = sec.querySelector('.ytm-qlist') || (() => {
    const d = el('div', 'ytm-qlist');
    sec.append(d);
    return d;
  })();

  // не пересобираем без изменений
  if (listEl.dataset.hash === String(libCache.length) + ':' + String(libMode ? libMode.list[libMode.index].id : '')) return;

  listEl.replaceChildren();
  listEl.dataset.hash = String(libCache.length) + ':' + String(libMode ? libMode.list[libMode.index].id : '');

  const playingId = libMode ? libMode.list[libMode.index].id : null;
  for (const trk of libCache) {
    const row = el('div', 'ytm-sc-row' + (trk.id === playingId ? ' playing' : ''));
    row.style.cursor = 'pointer';
    row.onclick = () => libToggle(trk.id);
    const badge = el('span', 'ytm-badge' + (trk.source === 'soundcloud' ? ' flac' : ''), trk.source === 'soundcloud' ? 'SC' : 'YT');
    badge.style.flex = 'none';
    const main = el('div', 'ytm-sc-main');
    main.append(el('div', 'ytm-sc-title', trk.title));
    main.append(el('div', 'ytm-sc-sub', [trk.info, trk.source === 'soundcloud' ? 'SoundCloud' : 'YouTube'].filter(Boolean).join(' · ')));
    row.append(badge, main);
    listEl.append(row);
  }
  if (!libCache.length) {
    listEl.append(el('div', 'ytm-status', t('qEmpty')));
  }
}

// Страховка OAuth: Google запрещает отображать себя в iframe (белый прямоугольник).
// Если SoundCloud воткнул такой iframe — открываем его содержимое нормальным
// попапом и убираем белый ящик.
function fixOauthIframes() {
  for (const f of document.querySelectorAll('iframe')) {
    const src = f.src || '';
    if (!/accounts\.google\.com\/(o\/oauth2|signin)|facebook\.com\/(login|dialog\/oauth)/.test(src)) continue;
    if (f.offsetWidth < 80 || f.offsetHeight < 80) continue;
    window.open(src, '_blank', 'width=480,height=640');
    f.remove();
    toast('Окно входа открыто отдельно');
  }
}

function boot() {
  if (booted) return;
  booted = true;
  buildDrawer();
  if (onYtm) {
    injectFabs();
    setInterval(() => { try { pollFlac(); refreshFabs(); } catch {} }, 500);
    setInterval(() => { try { placeBarOverlay(); } catch {} }, 800);
    setInterval(() => { try { updateQueueLibrary(); } catch {} }, 2000);
    // выбор песни на сайте → мгновенная проверка FLAC-наличия (без ожидания тика)
    document.addEventListener('play', (e) => {
      if (e.target && e.target.tagName === 'VIDEO') { try { lastFlacPoll = 0; pollFlac(); } catch {} }
    }, true);
  } else {
    injectScFab();
  }
  const tick = () => { try { patchDialogs(); dismissPromos(); fixStartPlayback(); fixOauthIframes(); applyPluginRemovals(); runPluginTicks(); } catch {} };
  tick();
  setInterval(tick, 2000);
  let t = null;
  new MutationObserver(() => {
    clearTimeout(t);
    t = setTimeout(tick, 500);
  }).observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') setDrawerOpen && setDrawerOpen(false);
  });
}

// Кнопка «⤓ FLAC» на страницах треков SoundCloud
function injectScFab() {
  const EXCLUDE = new Set(['likes', 'sets', 'playlists', 'albums', 'tracks', 'following',
    'followers', 'reposts', 'popular-tracks', 'you', 'discover', 'search', 'charts',
    'stations', 'people', 'pages', 'upload', 'settings', 'stream', 'library']);
  const isTrack = () => {
    const parts = location.pathname.split('/').filter(Boolean);
    return parts.length === 2 && !EXCLUDE.has(parts[1].toLowerCase());
  };
  const btn = el('button', 'ytm-scfab');
  btn.append(icon('download', 18), el('span', null, 'FLAC'));
  btn.title = t('scFabT');
  btn.onclick = () => {
    const title = (document.title.split('|')[0] || '').trim() || 'SoundCloud';
    ipcRenderer.send('sc-dl-page', { url: location.href, title });
    toast(t('mbQueued', { t: title }), null, 'download');
  };
  (document.body || document.documentElement).appendChild(btn);
  setInterval(() => { btn.style.display = isTrack() ? 'flex' : 'none'; }, 800);
}

// Мост и UI — на доверенных доменах: YouTube Music (полный набор) и
// SoundCloud (панель + кнопка скачивания). На любых других страницах
// приложения код не работает вовсе.
const YTM_HOSTS = new Set(['music.youtube.com', 'www.youtube.com', 'm.youtube.com']);
const SC_HOSTS = new Set(['soundcloud.com', 'www.soundcloud.com', 'm.soundcloud.com']);
const onYtm = YTM_HOSTS.has(location.hostname);

  if (onYtm || SC_HOSTS.has(location.hostname)) {
    contextBridge.exposeInMainWorld('ytmDesktop', {
      download: (fmt) => ipcRenderer.send('download-current', fmt),
      toggleDrawer,
      toast: (msg, ic) => toast(msg, null, ic),
    });

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
    else boot();
    // страховка от гонок готовности DOM (тяжёлые страницы SC)
    setTimeout(boot, 2500);
  }

const { app, BrowserWindow, WebContentsView, ipcMain, session, shell, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');
const DownloadManager = require('./lib/downloader');
const { ensureBinaries } = require('./lib/binaries');
const { loadConfig, saveConfig } = require('./lib/config');
const LibraryServer = require('./lib/library-server');
const Plugins = require('./lib/plugins');
const { t, autoDetect } = require('./lib/i18n');

// ── Миграция данных со старого имени (YT Music Desktop → FLACTube) ─────────
// app.name = productName, поэтому папка %APPDATA% сменилась. Переносим её один
// раз: вход в Google, сессия lossless-источника, конфиг и плагины переживают
// переименование без повторного логина.
try {
  const ud = app.getPath('userData');
  const prev = path.join(path.dirname(ud), 'YT Music Desktop');
  if (fs.existsSync(prev) && !fs.existsSync(ud)) fs.cpSync(prev, ud, { recursive: true });
} catch {}

// ── Блокировка рекламы (сетевой уровень) ────────────────────────────────────
// NB: @cliqz/adblocker тут нельзя — YouTube требует Trusted Types, инъекции
// cliqz их нарушают и сайт остаётся пустым. Поэтому свой список URL + чистка
// DOM в inject-preload.js.
const AD_URL_RE = /(doubleclick\.net|googlesyndication\.com|googleadservices\.com|\/pagead\/|pagead2\.googlesyndication|\/api\/stats\/ads|get_midroll_info|[?&]adformat=|[?&]ad_type=|ctier=L|\/ptracking|play\.google\.com\/log|\/log_event|adclick|adunit|\/youtubei\/v1\/player\/ads|\/ad_break|ad(doubleclick|service|sys))/i;

let win = null;
let view = null;

let dm = null;
let lib = new LibraryServer();
let plugins = null;
let installing = false;

const binDir = () => (app.isPackaged ? path.join(process.resourcesPath, 'bin') : path.join(__dirname, 'bin'));

const TOPBAR_H = 48; // высота браузерной панели сверху

// Один экземпляр приложения: повторный запуск ярлыка показывает существующее окно.
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.moveTop();
      win.focus();
    } else {
      createMainWindow();
    }
  });
}

// ── Безопасность ────────────────────────────────────────────────────────────
// Домены, которым разрешено открываться внутри приложения.
const ALLOWED_HOSTS = new Set([
  'music.youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtube.com',
  'accounts.google.com', 'accounts.youtube.com', 'myaccount.google.com',
  'policies.google.com', 'support.google.com', 'www.google.com',
  'www.gstatic.com', 'ssl.gstatic.com', 'apis.google.com',
  'content.googleapis.com', 'clients6.google.com',
  'soundcloud.com', 'secure.soundcloud.com', 'm.soundcloud.com',
  'www.youtube-nocookie.com',
  // логин через соцсети на SoundCloud
  'facebook.com', 'www.facebook.com', 'm.facebook.com', 'web.facebook.com',
  'appleid.apple.com', 'apple.com', 'www.apple.com',
]);
const hostAllowed = (u) => {
  try { return ALLOWED_HOSTS.has(new URL(u).hostname); } catch { return false; }
};
// about:blank и пустой URL — точки старта OAuth-попапов (SoundCloud проверяет
// доступность попапов именно window.open('')); дальше их сторожит глобальный
// will-navigate по ALLOWED_HOSTS
const navAllowed = (u) => {
  const s = String(u);
  return s === '' || s.startsWith('about:blank') || hostAllowed(s);
};
// IPC разрешён только нашим доверенным страницам (YouTube Music и SoundCloud)
const isTrustedSender = (e) => {
  try {
    const u = e.senderFrame ? e.senderFrame.url : '';
    return /^https:\/\/((music|www|m)\.)?youtube\.com\//.test(u)
      || /^https:\/\/((www|m)\.)?soundcloud\.com\//.test(u);
  } catch { return false; }
};
const secured = (fn) => (e, ...a) => {
  if (!isTrustedSender(e)) throw new Error('forbidden');
  return fn(e, ...a);
};

// Попапы логина (OAuth) и любые новые окна подчиняются той же политике:
// доверенные домены — внутри, остальное — в системный браузер.
app.on('web-contents-created', (_e, wc) => {
  // маскировка под Chrome в JS-слое: страница входа читает navigator.userAgentData
  wc.on('dom-ready', () => spoofUaInPage(wc));
  wc.on('did-finish-load', () => spoofUaInPage(wc));
  wc.setWindowOpenHandler(({ url }) => {
    if (navAllowed(url) || (/^https:\/\//.test(url) && hostAllowed(url))) {
      return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, backgroundColor: '#030303' } };
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  wc.on('will-navigate', (e, url) => {
    if (!url.startsWith('file://') && !navAllowed(url)) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
});

function defaultOutDir() {
  try { return path.join(app.getPath('music'), 'YT Music'); }
  catch { return path.join(app.getPath('downloads'), 'YT Music'); }
}

// ── Прокси, в т.ч. с авторизацией ───────────────────────────────────────────
let proxyAuth = null; // { user, pass } — для ответа 407 от HTTP-прокси в плеере

// Провайдеры часто выдают прокси одной строкой IP:PORT:USER:PASS — приводим к URL-виду.
// Голый host:port тоже принимаем как HTTP-прокси.
function normalizeProxy(raw) {
  const p = String(raw || '').trim().slice(0, 300);
  if (!p || /:\/\//.test(p)) return p;
  const cred = p.match(/^([\w.-]+):(\d{2,5}):([^:]+):(.+)$/);
  if (cred) return `http://${encodeURIComponent(cred[3])}:${encodeURIComponent(cred[4])}@${cred[1]}:${cred[2]}`;
  const bare = p.match(/^([\w.-]+):(\d{2,5})$/);
  return bare ? `http://${bare[1]}:${bare[2]}` : p;
}

// Достаём логин/пароль из user:pass@host:port
function readProxyAuth(p) {
  if (!p) return null;
  try {
    const u = new URL(p);
    return u.username ? { user: decodeURIComponent(u.username), pass: decodeURIComponent(u.password || '') } : null;
  } catch { return null; }
}

// 407 Proxy Authentication Required от прокси плеера — отвечаем сохранёнными кредами
app.on('login', (e, _wc, _details, authInfo, cb) => {
  if (authInfo && authInfo.isProxy && proxyAuth) {
    e.preventDefault();
    cb(proxyAuth.user, proxyAuth.pass);
  }
});

function toastInView(text, ic) {
  if (!view || view.webContents.isDestroyed()) return;
  view.webContents
    .executeJavaScript(`window.ytmDesktop && window.ytmDesktop.toast(${JSON.stringify(String(text))}, ${ic ? JSON.stringify(ic) : 'null'})`, true)
    .catch(() => {});
}

function broadcastJobs() {
  if (view && !view.webContents.isDestroyed()) view.webContents.send('jobs-changed', dm.list());
}

// Слитые правила JSON-плагинов → на страницу (стили/селекторы/диалоги)
function sendPlugins() {
  if (!view || view.webContents.isDestroyed()) return;
  const m = plugins.merged;
  view.webContents.send('plugins-changed', {
    css: m.css,
    hide: m.hide,
    remove: m.remove,
    js: m.js,
    dismiss: m.dismiss.map((r) => ({ match: r.match.source, click: r.click.source })),
  });
}

function sendBinProgress(msg) {
  if (view && !view.webContents.isDestroyed()) view.webContents.send('bin-progress', msg);
}

// Выезжающая панель загрузок живёт внутри страницы (inject-preload.js)
function toggleDrawer() {
  if (!view || view.webContents.isDestroyed()) return;
  view.webContents.executeJavaScript('window.ytmDesktop && window.ytmDesktop.toggleDrawer()', true).catch(() => {});
}

// ── Главное окно: WebContentsView с music.youtube.com ──────────────────────
function createMainWindow() {
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 920,
    minHeight: 600,
    backgroundColor: '#030303',
    show: false,
    autoHideMenuBar: true,
    title: 'FLACTube',
    icon: path.join(__dirname, 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'window-preload.js'),
      contextIsolation: true,
    },
  });
  win.loadFile(path.join(__dirname, 'renderer', 'topbar.html'));

  view = new WebContentsView({
    webPreferences: {
      partition: 'persist:ytm',
      preload: path.join(__dirname, 'inject-preload.js'),
      contextIsolation: true,
    },
  });
  view.setBackgroundColor('#030303');
  // чтобы рендер не замирал, когда окно перекрыто/свёрнуто (и музыка, и скрипты)
  view.webContents.setBackgroundThrottling(false);
  win.contentView.addChildView(view);

  const resize = () => {
    if (!win) return;
    const [w, h] = win.getContentSize();
    view.setBounds({ x: 0, y: TOPBAR_H, width: w, height: Math.max(0, h - TOPBAR_H) });
  };
  win.on('resize', resize);
  win.on('maximize', resize);
  win.on('unmaximize', resize);
  ['enter-full-screen', 'leave-full-screen'].forEach((ev) => win.on(ev, resize));
  win.on('focus', () => view && view.webContents.focus());
  win.on('closed', () => { win = null; app.quit(); });

  view.webContents.loadURL('https://music.youtube.com/');

  // Anti-idle: YouTube ставит трек на паузу («Video paused. Continue watching?»),
  // когда считает пользователя неактивным. Раз в 30 с шлём trusted mousemove
  // (1px туда-обратно в левом верхнем углу) — таймер бездействия сбрасывается,
  // плашка не появляется вовсе. Курсор на экране при этом не двигается:
  // sendInputEvent инжектит событие только в страницу.
  let idleFlip = false;
  setInterval(() => {
    if (!view || view.webContents.isDestroyed()) return;
    try {
      view.webContents.sendInputEvent({ type: 'mouseMove', x: idleFlip ? 1 : 0, y: 0 });
      idleFlip = !idleFlip;
    } catch {}
  }, 30_000);

  // Попапы логина: OAuth-провайдеры часто стартуют с about:blank и уже потом
  // navigируются на Google/Facebook — окно разрешаем создать, а его навигацию
  // сторожит глобальный фильтр ALLOWED_HOSTS (см. web-contents-created).
  view.webContents.setWindowOpenHandler(({ url }) => {
    const ok = navAllowed(url) || (/^https:\/\//.test(url) && hostAllowed(url));
    console.log('[popup]', ok ? 'allow' : 'deny+ext', JSON.stringify(url).slice(0, 120));
    if (ok) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 480,
          height: 640,
          autoHideMenuBar: true,
          backgroundColor: '#030303',
          title: 'Вход',
          // попап логина ДОЛЖЕН жить в той же сессии, что и плеер: иначе куки
          // Google оседают в defaultSession, основной вид их не видит, и «вход»
          // слетает после перезапуска
          webPreferences: { partition: 'persist:ytm', contextIsolation: true },
        },
      };
    }
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Внутри приложения — только доверенные домены, остальное — наружу
  view.webContents.on('will-navigate', (e, url) => {
    if (!hostAllowed(url)) {
      e.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });
  win.once('ready-to-show', () => {
    win.show();
    resize();
    view.webContents.focus();
    // Гарантированно поднимаем окно над остальными при запуске
    win.moveTop();
    win.focus();
    win.setAlwaysOnTop(true, 'screen-saver');
    setTimeout(() => { if (win && !win.isDestroyed()) win.setAlwaysOnTop(false); }, 1500);
    win.flashFrame(true);
    setTimeout(() => { if (win && !win.isDestroyed()) win.flashFrame(false); }, 3000);
  });
  view.webContents.on('did-finish-load', () => {
    view.webContents.focus();
    sendPlugins();
  });

  view.webContents.on('did-fail-load', (_e, code, desc, _url, isMainFrame) => {
    // -3 = ERR_ABORTED (отмена навигации), не показываем
    if (isMainFrame && code !== -3) {
      toastInView(t('mbYtmDown', { d: desc }), 'error');
    }
  });

  view.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
    if (input.key === 'F12') { view.webContents.toggleDevTools(); e.preventDefault(); }
    else if (input.key === 'F5' || (input.key.toLowerCase() === 'r' && input.control)) { view.webContents.reload(); e.preventDefault(); }
    else if (input.key === 'F9') { downloadCurrent('flac'); e.preventDefault(); }
    else if (input.key === 'F10') { togglePanel(); e.preventDefault(); }
    else if (input.key === 'F4') { app.relaunch(); app.exit(0); }
    else if (input.alt && input.key === 'ArrowLeft') { navAction('back'); e.preventDefault(); }
    else if (input.alt && input.key === 'ArrowRight') { navAction('forward'); e.preventDefault(); }
  });

  // Состояние навигации для верхней панели
  const pushNavState = () => {
    if (!win || win.isDestroyed() || !view || view.webContents.isDestroyed()) return;
    const wc = view.webContents;
    let url = '', canBack = false, canForward = false;
    try {
      url = wc.getURL();
      canBack = wc.canGoBack();
      canForward = wc.canGoForward();
    } catch {}
    win.webContents.send('nav-state', { url, canBack, canForward, loading: wc.isLoading() });
  };
  ['did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading']
    .forEach((ev) => view.webContents.on(ev, pushNavState));
  win.webContents.on('did-finish-load', pushNavState);
}

function togglePanel() { toggleDrawer(); }

// ── Скачивание текущего трека ───────────────────────────────────────────────
async function downloadCurrent(fmt) {
  try {
    if (!view || view.webContents.isDestroyed() || !dm) return;
    const info = await view.webContents.executeJavaScript(`(() => {
      let id = null;
      try { id = new URL(location.href).searchParams.get('v'); } catch (e) {}
      if (!id) {
        const a = document.querySelector('ytmusic-player-bar a[href*="watch?v="]');
        if (a) { const m = a.href.match(/[?&]v=([\\w-]{11})/); if (m) id = m[1]; }
      }
      const md = navigator.mediaSession && navigator.mediaSession.metadata;
      const barTitle = document.querySelector('ytmusic-player-bar .title');
      return {
        id,
        title: (md && md.title) || (barTitle && barTitle.textContent) || 'track',
        artist: (md && md.artist) || '',
      };
    })()`, true);

    if (!info || !/^[\w-]{11}$/.test(info.id || '')) {
      toastInView(t('mbNoTrack'), 'error');
      return;
    }
    if (!dm.hasBin('yt-dlp')) {
      toastInView(t('mbNoBin'));
      togglePanel();
      return;
    }
    const format = fmt === 'copy' ? 'copy' : 'flac';
    dm.add(info, format);
    toastInView(format === 'copy' ? t('mbOrig', { t: info.title }) : t('mbDl', { t: info.title }), 'download');
  } catch (e) {
    toastInView('Ошибка: ' + (e && e.message));
  }
}

// ── Метаданные библиотеки (library.json рядом с треками) ────────────────────
function libMetaPath() { return path.join(dm.outDir, 'library.json'); }
function readLibMeta() {
  try { return JSON.parse(fs.readFileSync(libMetaPath(), 'utf8')); } catch { return {}; }
}
function writeLibMeta(meta) {
  try { fs.writeFileSync(libMetaPath(), JSON.stringify(meta)); } catch {}
}

// Реальные данные о файле через ffprobe (кодек · частота · битрейт)
function probeFile(p) {
  try {
    const fp = path.join(binDir(), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    if (!fs.existsSync(fp)) return null;
    const r = spawnSync(fp, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', p], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0 || !r.stdout) return null;
    const j = JSON.parse(r.stdout);
    const fmt = j.format || {};
    const st = (j.streams || []).find((s) => s.codec_type === 'audio') || {};
    const parts = [
      (st.codec_name || '').toUpperCase(),
      st.sample_rate ? (Math.round(st.sample_rate / 100) / 10) + ' kHz' : '',
      fmt.bit_rate ? Math.round(fmt.bit_rate / 1000) + ' kbps' : '',
    ].filter(Boolean);
    return parts.length ? parts.join(' · ') : null;
  } catch { return null; }
}

// Куки SoundCloud из сессии приложения → файл для yt-dlp
async function exportScCookies() {
  const ses = session.fromPartition('persist:ytm');
  const all = await ses.cookies.get({});
  const sc = all.filter((c) => (c.domain || '').includes('soundcloud'));
  let txt = '# Netscape HTTP Cookie File\n';
  for (const c of sc) {
    txt += [
      c.domain || '',
      c.hostOnly ? 'TRUE' : 'FALSE',
      c.path || '/',
      c.secure ? 'TRUE' : 'FALSE',
      c.expirationDate ? Math.floor(c.expirationDate) : 0,
      c.name,
      c.value,
    ].join('\t') + '\n';
  }
  const p = path.join(app.getPath('userData'), 'sc.cookies.txt');
  fs.writeFileSync(p, txt);
  if (dm) dm.setCookiesFile(p);
  return { path: p, count: sc.length };
}

// ── Навигация (панель сверху) ───────────────────────────────────────────────
function navAction(action) {
  if (!view || view.webContents.isDestroyed()) return;
  const wc = view.webContents;
  try {
    if (action === 'back' && wc.canGoBack()) wc.goBack();
    else if (action === 'forward' && wc.canGoForward()) wc.goForward();
    else if (action === 'reload') wc.reload();
    else if (action === 'stop') wc.stop();
    else if (action === 'home') wc.loadURL('https://music.youtube.com/');
    else if (action === 'panel') toggleDrawer();
    else if (action === 'restart') {
      // полный чистый перезапуск: лечит любые зависшие состояния
      app.relaunch();
      app.exit(0);
    }
  } catch (e) {
    console.warn('[nav]', action, e.message);
  }
}

// ── IPC ─────────────────────────────────────────────────────────────────────
function setupIpc() {
  ipcMain.on('nav', (e, action) => navAction(action));
  ipcMain.on('download-current', (e, fmt) => {
    if (!isTrustedSender(e)) return;
    downloadCurrent(fmt);
  });
  // «⤓ FLAC» на странице трека SoundCloud
  ipcMain.on('sc-dl-page', (e, info) => {
    if (!isTrustedSender(e) || !info) return;
    const url = String(info.url || '');
    // строго: https://soundcloud.com/исполнитель/трек
    if (!/^https:\/\/((www|m)\.)?soundcloud\.com\/[\w-]+\/[\w-]+\/?$/.test(url)) return;
    const slug = url.split('/').filter(Boolean).pop().slice(0, 32);
    dm.add({
      source: 'soundcloud',
      id: slug,
      title: String(info.title || 'SoundCloud').slice(0, 150),
      pageUrl: url,
    }, 'flac');
  });

  ipcMain.handle('panel:state', secured(() => ({
    jobs: dm.list(),
    outDir: dm.outDir,
    proxy: dm.proxy || '',
    losslessApi: dm.tidalApi || '',
    bins: { ytdlp: dm.hasBin('yt-dlp'), ffmpeg: dm.hasBin('ffmpeg') },
  })));
  ipcMain.handle('panel:download-current', secured((e, fmt) => downloadCurrent(fmt)));
  ipcMain.handle('panel:choose-outdir', secured(async () => {
    const r = await dialog.showOpenDialog(win, {
      title: 'Куда сохранять треки',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (!r.canceled && r.filePaths[0]) {
      dm.setOutDir(r.filePaths[0]);
      lib.setDir(dm.outDir);
      saveConfig({ outDir: dm.outDir });
      broadcastJobs();
    }
    return dm.outDir;
  }));
  ipcMain.handle('panel:set-proxy', secured(async (e, raw) => {
    const proxy = normalizeProxy(raw);
    // допускаем только правдоподобные прокси-адреса (user:pass@ — опционально,
    // в пароле возможны любые символы кроме @ и /)
    if (proxy && !/^(https?|socks4a?|socks5h?):\/\/([^@/\s]+@)?[\w.-]+:\d{2,5}(\/.*)?$/i.test(proxy)) {
      throw new Error('формат: http://host:port · socks5://ip:port · IP:port:user:pass');
    }
    saveConfig({ proxy });
    dm.setProxy(proxy);
    proxyAuth = readProxyAuth(proxy);
    const ses = session.fromPartition('persist:ytm');
    await ses.setProxy(proxy ? { mode: 'fixed_servers', proxies: [proxy] } : { mode: 'system' });
    if (view && !view.webContents.isDestroyed()) view.webContents.reload();
    return proxy;
  }));
  ipcMain.handle('panel:open-folder', secured(() => {
    fs.mkdirSync(dm.outDir, { recursive: true });
    shell.openPath(dm.outDir);
  }));
  ipcMain.handle('panel:cancel', secured((e, id) => dm.cancel(id)));
  ipcMain.handle('panel:set-lossless', secured(async (e, url) => {
    url = String(url || '').trim().slice(0, 300);
    if (url && !/^https?:\/\/[\w.-]+/.test(url)) throw new Error('нужен URL вида https://сервер/');
    saveConfig({ losslessApi: url });
    dm.setTidalApi(url);
    return url;
  }));
  // Пользовательские JSON-плагины
  ipcMain.handle('plugins:state', secured(() => ({ dir: plugins.dir, list: plugins.list })));
  ipcMain.handle('plugins:reload', secured(() => {
    const i = plugins.load();
    sendPlugins();
    return i;
  }));
  ipcMain.handle('plugins:open-folder', secured(() => {
    fs.mkdirSync(plugins.dir, { recursive: true });
    shell.openPath(plugins.dir);
  }));
  // Словарь переводов для sandboxed preload (require там недоступен).
  // Без trusted-проверки: preload вызывает это на старте страницы,
  // а наружу уходят только строки переводов.
  ipcMain.on('i18n:init', (e, override) => {
    const { STR, ORDER, LABELS, detect } = require('./lib/i18n');
    e.returnValue = {
      str: STR,
      order: ORDER,
      labels: LABELS,
      lang: override && ORDER.includes(override) ? override : detect(app.getLocale()),
    };
  });
  ipcMain.handle('sc-search', secured((e, q) => dm.scQuery(`scsearch12:${String(q || '').slice(0, 200)}`)));
  ipcMain.handle('download-url', secured((e, track, fmt) => {
    if (!dm || !track || typeof track !== 'object') return null;
    const clean = {
      source: track.source === 'soundcloud' ? 'soundcloud' : 'youtube',
      id: String(track.id || track.videoId || '').slice(0, 32),
      title: String(track.title || 'track').slice(0, 150),
      pageUrl: /^https:\/\/([\w-]+\.)*soundcloud\.com\//.test(track.pageUrl || '') ? track.pageUrl : '',
    };
    return dm.add(clean, fmt).id;
  }));
  ipcMain.handle('library:list', secured(() => {
    const out = [];
    let files = [];
    try { files = fs.readdirSync(dm.outDir); } catch {}
    const meta = readLibMeta();
    let probes = 0;
    for (const f of files) {
      // только аудио: обложки .webp с тем же [ID] не считаем треками
      const m = f.match(/^(.+) \[([\w-]+)\]\.(flac|m4a|mp3|opus|webm|ogg|wav|aac)$/i);
      if (!m) continue;
      const id = m[2];
      let st;
      try { st = fs.statSync(path.join(dm.outDir, f)); } catch { continue; }
      const mt = meta[id] || {};
      if (!mt.info && probes < 12) { mt.info = probeFile(path.join(dm.outDir, f)); meta[id] = mt; probes++; }
      out.push({
        id,
        title: m[1],
        ext: m[3],
        size: st.size,
        mtime: st.mtimeMs,
        source: mt.source || (mt.pageUrl && /soundcloud/.test(mt.pageUrl) ? 'soundcloud' : ''),
        info: mt.info || null,
        pageUrl: mt.pageUrl || '',
        url: lib.url(id),
      });
    }
    if (probes) writeLibMeta(meta);
    out.sort((a, b) => a.mtime - b.mtime); // по порядку добавления
    return out;
  }));
  ipcMain.handle('sc-open-login', secured(() => {
    if (view && !view.webContents.isDestroyed()) {
      view.webContents.loadURL('https://soundcloud.com/');
      toastInView(t('mbScLogin'));
    }
  }));
  ipcMain.handle('sc-cookies-export', secured(() => exportScCookies()));
  ipcMain.handle('sc-import', secured(async (e, url) => {
    url = String(url || '').trim();
    if (!/^https:\/\/(www\.|m\.)?(soundcloud\.com|api\.soundcloud\.com)\//.test(url)) {
      throw new Error('нужна ссылка вида https://soundcloud.com/ник/likes');
    }
    await exportScCookies().catch(() => null);
    return dm.scQuery(url);
  }));
  ipcMain.handle('library:delete', secured((e, id) => {
    if (!id || !/^[\w-]{4,32}$/.test(id)) throw new Error('bad id');
    let removed = 0;
    try {
      for (const f of fs.readdirSync(dm.outDir)) {
        if (f.includes(`[${id}]`)) {
          try { fs.rmSync(path.join(dm.outDir, f), { force: true }); removed++; } catch {}
        }
      }
    } catch {}
    const meta = readLibMeta();
    if (meta[id]) { delete meta[id]; writeLibMeta(meta); }
    lib.clearCache();
    return removed;
  }));
  ipcMain.handle('library:check', secured((e, id) => {
    if (!id || !/^[\w-]{4,32}$/.test(id)) return null;
    const f = lib.findFile(id);
    return f ? { url: lib.url(id) } : null;
  }));
  ipcMain.handle('panel:install-binaries', secured(async () => {
    if (installing) return false;
    installing = true;
    try {
      await ensureBinaries(binDir(), sendBinProgress);
      sendBinProgress('✅ Бинарники готовы');
    } catch (err) {
      sendBinProgress('❌ ' + (err && err.message));
    } finally {
      installing = false;
    }
    broadcastJobs();
    return true;
  }));
}

// ── Маскировка под Chrome для Google-логина ─────────────────────────────────
// Google блокирует вход («This browser or app may not be secure»), если браузер
// саморазоблачится. User-Agent мы уже чистим, но Chromium ЕЩЁ шлёт client-hints
// заголовки (Sec-CH-UA) со брендами «Chromium/Electron», а страница входа читает
// то же самое из navigator.userAgentData. Закрываем все три слоя: строка UA
// (userAgentFallback ниже), заголовки (maskBrowserHeaders), JS-объект (spoofUaInPage).
const CHROME_VER = process.versions.chrome; // полный, напр. '130.0.6723.44'
const CHROME_MAJOR = CHROME_VER.split('.')[0];
// ВАЖНО: полная версия движка, не MAJOR.0.0.0 — гугл сравнивает заголовок с
// navigator.userAgent в JS, и расхождение (130.0.0.0 vs 130.0.6723.44) палится
// как подделка → «Couldn't sign you in»
const CHROME_UA = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROME_VER} Safari/537.36`;
const CHROME_HINTS = `"Google Chrome";v="${CHROME_MAJOR}", "Chromium";v="${CHROME_MAJOR}", "Not_A Brand";v="24"`;
const CHROME_HINTS_FULL = `"Google Chrome";v="${CHROME_VER}", "Chromium";v="${CHROME_VER}", "Not_A Brand";v="24.0.0.0"`;

// Заголовки: применяется к сессии плеера и к defaultSession (попапы логина)
function maskBrowserHeaders(ses) {
  try { ses.setUserAgent(CHROME_UA); } catch {}
  ses.webRequest.onBeforeSendHeaders({ urls: ['*://*/*'] }, (details, cb) => {
    try {
      const h = { ...details.requestHeaders };
      for (const k of Object.keys(h)) if (/^sec-ch-ua/i.test(k)) delete h[k];
      h['User-Agent'] = CHROME_UA;
      h['sec-ch-ua'] = CHROME_HINTS;
      h['sec-ch-ua-mobile'] = '?0';
      h['sec-ch-ua-platform'] = '"Windows"';
      h['sec-ch-ua-full-version-list'] = CHROME_HINTS_FULL;
      cb({ requestHeaders: h });
    } catch {
      cb({});
    }
  });
}

// JS-слой: подменяем navigator.userAgentData в мире страницы. executeJavaScript
// всегда исполняется в main world — contextIsolation не мешает. Guard от повторов.
const UA_SPOOF_JS = `(function(){
  try {
    if (navigator.__ftSpoof) return;
    var v = ${JSON.stringify(CHROME_VER)};
    var m = ${JSON.stringify(CHROME_MAJOR)};
    var brands = [{brand:'Google Chrome',version:m},{brand:'Chromium',version:m},{brand:'Not_A Brand',version:'24'}];
    var fullList = [{brand:'Google Chrome',version:v},{brand:'Chromium',version:v},{brand:'Not_A Brand',version:'24.0.0.0'}];
    var uaData = {
      brands: brands,
      mobile: false,
      toJSON: function(){ return { brands: brands, mobile: false }; },
      getHighEntropyValues: function(hints){
        var out = {};
        hints = hints || [];
        if (hints.indexOf('architecture') >= 0) out.architecture = 'x86';
        if (hints.indexOf('bitness') >= 0) out.bitness = '64';
        if (hints.indexOf('model') >= 0) out.model = '';
        if (hints.indexOf('platform') >= 0) out.platform = 'Windows';
        if (hints.indexOf('platformVersion') >= 0) out.platformVersion = '15.0.0';
        if (hints.indexOf('uaFullVersion') >= 0) out.uaFullVersion = v;
        if (hints.indexOf('fullVersionList') >= 0) out.fullVersionList = fullList;
        if (hints.indexOf('formFactors') >= 0) out.formFactors = ['Desktop'];
        return Promise.resolve(out);
      }
    };
    Object.defineProperty(navigator, 'userAgentData', { get: function(){ return uaData; }, configurable: true });
    navigator.__ftSpoof = true;
  } catch (e) {}
})();`;

function spoofUaInPage(wc) {
  let url = '';
  try { url = wc.getURL(); } catch {}
  if (!/^https:\/\//i.test(url)) return; // топбар (file://) не трогаем
  wc.executeJavaScript(UA_SPOOF_JS, false).catch(() => {});
}

// ── Сессия: блокировка рекламных запросов ───────────────────────────────────
async function setupSession() {
  const ses = session.fromPartition('persist:ytm');
  // полная маскировка под Chrome: сессия плеера + defaultSession (попапы логина)
  maskBrowserHeaders(ses);
  maskBrowserHeaders(session.defaultSession);
  // разовая чистка кэша старого блокировщика (cliqz)
  try { fs.rmSync(path.join(app.getPath('userData'), 'adblock-cache.bin'), { force: true }); } catch {}

  ses.webRequest.onBeforeRequest({ urls: ['*://*/*'] }, (details, cb) => {
    // базовый список + blockUrls из пользовательских JSON-плагинов
    const extra = plugins ? plugins.merged.blockUrls : [];
    const u = details.url;
    // домены логина гугла не трогаем: там нет рекламы, но есть телеметрия
    // (/log_event, play.google.com/log), которую гугл считает обязательной —
    // без неё вход помечается небезопасным
    const isAuth = /accounts\.google\.com|accounts\.youtube\.com|myaccount\.google\.com/.test(u);
    cb({ cancel: !isAuth && (AD_URL_RE.test(u) || extra.some((re) => re.test(u))) });
  });

  // Разрешаем странице грузить локальные треки (CSP). ВАЖНО: у YouTube нет
  // своей media-src (звук идёт через blob:, разрешённый через default-src),
  // поэтому добавлять ДИРЕКТИВУ media-src нельзя — она сузит политику и
  // убьёт blob-аудио. Только дописываем свой origin к существующему
  // default-src (CSP — allow-list: добавление источника ничего не запрещает).
  // NB: responseHeaders здесь — объект { имя: [значения] }, не массив
  const libOrigin = `http://127.0.0.1:${lib.port}`;
  ses.webRequest.onHeadersReceived({ urls: ['https://music.youtube.com/*'] }, (details, cb) => {
    try {
      const headers = details.responseHeaders || {};
      let changed = false;
      for (const name of Object.keys(headers)) {
        if (!/^content-security-policy$/i.test(name)) continue;
        headers[name] = (headers[name] || []).map((v) => {
          if (!v) return v;
          if (/media-src/i.test(v)) {
            changed = true;
            return v.replace(/media-src([^;]*)/i, (d) => d + ' ' + libOrigin);
          }
          if (/default-src([^;]*)/i.test(v)) {
            changed = true;
            return v.replace(/default-src([^;]*)/i, (d) => d + ' ' + libOrigin);
          }
          return v;
        });
      }
      cb(changed ? { responseHeaders: headers } : {});
    } catch {
      cb({});
    }
  });
}

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.setAppUserModelId('app.flactube');

// NB: с Zapret НЕ отключаем QUIC — замер показал, что HTTP/3 к Google летает
// (avg 4 мс), а медленные как раз TCP-запросы (h2, avg 1.1 c) из-за
// провайдерского троттлинга. QUIC в этой ситуации только помогает.

// Google блокирует вход из «неизвестных браузеров» (строка Electron в UA) —
// маскируемся под обычный Chrome той же версии.
// navigator.userAgent в страницах = userAgentFallback: держим его строго
// равным заголовку CHROME_UA — гугл сверяет эти два слоя при логине
app.userAgentFallback = CHROME_UA;

// Прокси из конфига — до готовности приложения (нормализуем IP:port:user:pass тоже)
const startCfg = loadConfig();
const startProxy = normalizeProxy(startCfg.proxy);
if (startProxy) app.commandLine.appendSwitch('proxy-server', startProxy);
proxyAuth = readProxyAuth(startProxy);

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  autoDetect(app.getLocale());
  fs.mkdirSync(defaultOutDir(), { recursive: true });

  dm = new DownloadManager(binDir(), startCfg.outDir || defaultOutDir());
  dm.setProxy(startProxy);
  dm.setTidalApi(startCfg.losslessApi || '');
  // community-серверы SpotiFLAC — дефолтный lossless-источник
  dm.setCommunity(path.join(app.getPath('userData'), 'community_session.json'), (url) => {
    shell.openExternal(url);
    toastInView('🎧 Пройди проверку в браузере (lossless-источник) — окно уже открылось', 10000);
  });
  dm.on('notify', (msg) => toastInView(msg, 8000));
  // Папка пользовательских JSON-плагинов
  plugins = new Plugins(path.join(app.getPath('userData'), 'plugins'));
  fs.mkdirSync(plugins.dir, { recursive: true });
  {
    const pinfo = plugins.load();
    console.log('[plugins] активно ' + pinfo.ok + ' из ' + pinfo.count + ' — папка: ' + plugins.dir);
  }
  dm.on('changed', broadcastJobs);
  dm.on('added', (job) => toastInView(t('mbQueued', { t: job.title }), 'download'));
  dm.on('done', (job) => {
    toastInView(t('mbDone', { t: job.title }), 'check');
    lib.clearCache();
    // метаданные для библиотеки (можно восстановить/узнать источник)
    try {
      const meta = readLibMeta();
      const m = job.file && job.file.match(/\.(\w+)$/);
      // реальный ID из имени файла (yt-dlp для SC подставляет числовой ID трека)
      const realId = (job.file && (job.file.match(/\[([\w-]{4,32})\]\.\w+$/) || [])[1]) || job.videoId;
      meta[realId] = {
        ...(meta[realId] || {}),
        title: job.title,
        source: job.source || 'youtube',
        pageUrl: job.pageUrl || '',
        ext: m ? m[1] : '',
        addedAt: Date.now(),
      };
      writeLibMeta(meta);
    } catch {}
  });
  dm.on('failed', (job) => toastInView(t('mbFail', { t: job.title, e: job.error }), 'error'));

  await lib.start(dm.outDir);
  console.log('[library] локальные треки: ' + lib.url('ID') + ' (порт ' + lib.port + ')');
  // самопроверка сервера: с токеном маршрут отвечает, без токена — нет
  {
    const t0 = Date.now();
    try {
      const good = await fetch(lib.url('selftest')).then((r) => r.status).catch(() => 'fail');
      let bad = 'skip';
      try { bad = await fetch(`http://127.0.0.1:${lib.port}/${'0'.repeat(48)}/audio/selftest`).then((r) => r.status); } catch {}
      console.log('[library] self-test: с токеном=' + good + ' без токена=' + bad + ' за ' + (Date.now() - t0) + ' мс');
    } catch (e) {
      console.log('[library] self-test FAIL:', e.message);
    }
  }

  setupIpc();
  await setupSession();
  createMainWindow();
  // Панель загрузок открывается по F10 или при скачивании — не мешаем при старте.
});

app.on('window-all-closed', () => app.quit());

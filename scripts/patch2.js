const fs = require('fs');
const p = 'D:/youtube/ytm-desktop/inject-preload.js';
let s = fs.readFileSync(p, 'utf8');
let ok = 0;
function rep(a, b) {
  if (!s.includes(a)) { console.log('MISS:', a.slice(0, 60).replace(/\n/g, ' ')); return; }
  s = s.replace(a, b);
  ok++;
}

// 1. Секция библиотеки: инструменты (шафл + вход SC)
rep(
`  // — общая библиотека —
  const libStatus = el('div', 'ytm-status', '');
  const libList = el('div');
  viewLib.append(libStatus, libList);`,
`  // — общая библиотека —
  const libTools = el('div', 'ytm-row');
  const shuffleBtn = el('button', 'ytm-btn', '🔀 вперемешку');
  shuffleBtn.title = 'Случайный порядок для ⏭/⏮';
  const loginBtn = el('button', 'ytm-btn', '🔑 SoundCloud');
  loginBtn.title = 'Войти в аккаунт SoundCloud внутри приложения (куки сохранятся)';
  libTools.append(shuffleBtn, loginBtn);
  const libStatus = el('div', 'ytm-status', '');
  const libList = el('div');
  viewLib.append(libTools, libStatus, libList);`
);

// 2. Секция поиска: строка импорта лайков
rep(
`  const searchStatus = el('div', 'ytm-status', 'Для треков, которых нет или которые зацензурены на YouTube');
  const searchResults = el('div');
  viewSearch.append(searchRow, searchStatus, searchResults);`,
`  const importRow = el('div', 'ytm-row');
  const importInput = el('input', 'ytm-input');
  importInput.placeholder = 'ссылка на лайки: soundcloud.com/ник/likes';
  importInput.spellcheck = false;
  const importBtn = el('button', 'ytm-btn', '❤');
  importBtn.title = 'Импорт треков из лайков/плейлиста SoundCloud';
  importRow.append(importInput, importBtn);
  const searchStatus = el('div', 'ytm-status', 'Для треков, которых нет или которые зацензурены на YouTube');
  const dlAll = el('button', 'ytm-btn', '⤓⤓ Скачать всё найденное');
  dlAll.style.display = 'none';
  const searchResults = el('div');
  viewSearch.append(searchRow, importRow, searchStatus, dlAll, searchResults);`
);

// 3. doSearch: запоминаем результаты для «скачать всё»
rep(
`      const results = await ipcRenderer.invoke('sc-search', q);
      renderSearchResults(results);`,
`      const results = await ipcRenderer.invoke('sc-search', q);
      lastResults = results;
      renderSearchResults(results);`
);

// 4. Хендлеры импорта/шафла/логина + download-all (вставляем перед renderSearchResults)
rep(
`  function renderSearchResults(results) {
    searchResults.replaceChildren();`,
`  let lastResults = [];
  importBtn.onclick = async () => {
    const url = importInput.value.trim();
    if (!url) return;
    importBtn.disabled = true;
    searchStatus.style.display = 'block';
    searchStatus.textContent = '❤ импортирую (может занять минуту)…';
    try {
      const results = await ipcRenderer.invoke('sc-import', url);
      lastResults = results;
      renderSearchResults(results);
      dlAll.style.display = results.length ? '' : 'none';
      if (!results.length) searchStatus.textContent = 'пусто (лайки приватные? войди через 🔑 и повтори)';
      else searchStatus.style.display = 'none';
    } catch (e) {
      searchStatus.textContent = '❌ ' + ((e && e.message) || 'ошибка импорта');
    }
    importBtn.disabled = false;
  };
  dlAll.onclick = async () => {
    for (const r of lastResults) {
      await ipcRenderer.invoke('download-url', { source: 'soundcloud', id: r.id, title: r.title, pageUrl: r.url }, 'flac').catch(() => null);
    }
    toast('⤓ Всё в очереди — прогресс во вкладке «Загрузки»');
  };
  shuffleBtn.onclick = () => {
    shuffleOn = !shuffleOn;
    shuffleBtn.classList.toggle('primary', shuffleOn);
    if (libMode) libMode.order = null;
    toast(shuffleOn ? '🔀 Случайный порядок' : '▶ Порядок добавления');
  };
  loginBtn.onclick = () => ipcRenderer.invoke('sc-open-login');

  function renderSearchResults(results) {
    searchResults.replaceChildren();`
);

// 5. Строки библиотеки: формат из ffprobe + бейдж источника
rep(
`      const row = el('div', 'ytm-lib-row');
      row.dataset.id = t.id;
      const btn = el('button', 'ytm-libbtn', '▶');
      btn.title = 'Слушать из библиотеки';
      btn.onclick = () => libToggle(t.id);
      const main = el('div', 'ytm-sc-main');
      main.append(el('div', 'ytm-sc-title', t.title));
      main.append(el('div', 'ytm-sc-sub', (t.ext || '').toUpperCase() + ' · ' + (t.size / 1048576).toFixed(1) + ' МБ'));
      row.append(btn, main);
      libList.append(row);`,
`      const row = el('div', 'ytm-lib-row');
      row.dataset.id = t.id;
      const btn = el('button', 'ytm-libbtn', '▶');
      btn.title = 'Слушать из библиотеки';
      btn.onclick = () => libToggle(t.id);
      const main = el('div', 'ytm-sc-main');
      main.append(el('div', 'ytm-sc-title', t.title));
      main.append(el('div', 'ytm-sc-sub', [t.info, (t.size / 1048576).toFixed(1) + ' МБ'].filter(Boolean).join(' · ')));
      row.append(btn, main);
      if (t.source === 'soundcloud' || t.source === 'youtube') {
        const sb = el('span', 'ytm-badge' + (t.source === 'soundcloud' ? ' flac' : ''), t.source === 'soundcloud' ? 'SC' : 'YT');
        row.append(sb);
      }
      libList.append(row);`
);

// 6. Сабтайтл в плеер-баре: реальные данные FLAC из ffprobe
rep(
`  ov.querySelector('.ytm-bo-sub').textContent =
    (entry.ext || '').toUpperCase() + ' · локальная библиотека · ' + (libMode.index + 1) + ' из ' + libMode.list.length;`,
`  ov.querySelector('.ytm-bo-sub').textContent =
    [entry.info, (entry.ext || '').toUpperCase(), 'библиотека ' + (libMode.index + 1) + '/' + libMode.list.length].filter(Boolean).join(' · ');`
);

fs.writeFileSync(p, s);
console.log('applied:', ok);

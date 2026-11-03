// SpotiFLAC-подобный конвейер:
//  1) резолв трека через публичный Deezer API → точные имена, ISRC, обложка
//  2) (опц.) lossless-источник: tidal-api-совместимый сервер по ISRC
//  3) обложка для встраивания
const { spawnSync } = require('child_process');

const DEEZER_TIMEOUT = 12000;

async function fetchJson(url, timeout = DEEZER_TIMEOUT) {
  const r = await fetch(url, {
    signal: AbortSignal.timeout(timeout),
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r.json();
}

// Нормализация строки для сравнения (как в spotiflac: lowercase, без пунктуации)
function norm(s) {
  return String(s || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// Поиск в Deezer: title + artist → точный матч (или лучший), ISRC, альбом, обложка
async function lookupDeezer(title, artist) {
  const q = [title, artist].filter(Boolean).map((s) => String(s).slice(0, 80)).join(' ');
  if (!q.trim()) return null;
  let data;
  try {
    data = await fetchJson('https://api.deezer.com/search/track?q=' + encodeURIComponent(q) + '&limit=8');
  } catch {
    return null;
  }
  const list = (data && data.data) || [];
  if (!list.length) return null;

  const nTitle = norm(title);
  const nArtist = norm(artist);
  let best = null;
  let bestScore = -1;
  for (const t of list) {
    let score = 0;
    if (nTitle && norm(t.title) === nTitle) score += 10;
    else if (nTitle && norm(t.title).includes(nTitle)) score += 4;
    if (nArtist && norm(t.artist && t.artist.name) === nArtist) score += 6;
    else if (nArtist && norm(t.artist && t.artist.name).includes(nArtist)) score += 2;
    if (t.isrc) score += 1;
    if (score > bestScore) { bestScore = score; best = t; }
  }
  if (!best || bestScore < 3) return null;

  return {
    isrc: best.isrc || '',
    title: best.title || '',
    artist: (best.artist && best.artist.name) || '',
    album: (best.album && best.album.title) || '',
    year: (best.release_date || '').slice(0, 4),
    trackNum: best.track_position || 0,
    discNum: best.disk_number || 1,
    cover: (best.album && (best.album.cover_xl || best.album.cover_big)) || '',
    rank: best.rank || 0,
    matched: bestScore >= 10,
  };
}

// Поиск в Deezer строго по ISRC (для lossless-источника)
async function lookupDeezerByIsrc(isrc) {
  try {
    const t = await fetchJson('https://api.deezer.com/track/isrc:' + encodeURIComponent(String(isrc).toUpperCase()));
    if (!t || !t.id || (t.error && t.error.message)) return null;
    return {
      isrc: t.isrc || isrc,
      title: t.title || '',
      artist: (t.artist && t.artist.name) || '',
      album: (t.album && t.album.title) || '',
      year: (t.release_date || '').slice(0, 4),
      cover: (t.album && (t.album.cover_xl || t.album.cover_big)) || '',
    };
  } catch {
    return null;
  }
}

// Скачиваем обложку во временный файл
async function downloadCover(url, dest) {
  if (!url) return false;
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!r.ok) return false;
    const buf = Buffer.from(await r.arrayBuffer());
    if (buf.length < 5000) return false; // не картинка
    require('fs').writeFileSync(dest, buf);
    return true;
  } catch {
    return false;
  }
}

// Тidal-api-совместимый lossless источник (как кастомные инстансы SpotiFLAC):
//   GET {base}/search?q=isrc:XXXX         → [{ id, title, ... }]
//   GET {base}/track/?id=N&quality=LOSSLESS → { data: { manifest } } или прямая ссылка
async function losslessResolve(apiBase, isrc, quality) {
  const base = String(apiBase || '').trim().replace(/\/+$/, '');
  if (!/^https?:\/\//.test(base) || !isrc) return null;

  // 1) ищем track id по ISRC (Tidal-поиск понимает isrc:)
  let items = null;
  try {
    items = await fetchJson(base + '/search?q=' + encodeURIComponent('isrc:' + isrc), 15000);
  } catch {
    try {
      items = await fetchJson(base + '/api/search?q=' + encodeURIComponent('isrc:' + isrc), 15000);
    } catch { return null; }
  }
  const arr = Array.isArray(items) ? items : (items && (items.data || items.results || items.tracks)) || [];
  const hit = arr[0];
  if (!hit || !(hit.id || hit.trackId)) return null;
  const trackId = hit.id || hit.trackId;

  // 2) получаем поток
  const q = quality || 'LOSSLESS';
  const attempts = [
    base + '/track/?id=' + trackId + '&quality=' + q,
    base + '/api/track/?id=' + trackId + '&quality=' + q,
  ];
  for (const url of attempts) {
    try {
      const j = await fetchJson(url, 20000);
      // форматы: {data:{manifest}} / [{manifest}] / {url} / {data:[{url}]}
      const manifest = (j.data && j.data.manifest) || (Array.isArray(j) && j[0] && j[0].manifest) || '';
      if (manifest) return { kind: 'manifest', manifest, trackId, quality: (j.data && j.data.audioQuality) || q };
      const direct = (j.url) || (j.data && j.data[0] && j.data[0].url) || '';
      if (direct) return { kind: 'url', url: direct, trackId, quality: q };
    } catch {}
  }
  return null;
}

// ffprobe: длительность/кодек (для проверки результата)
function probeInfo(ffprobePath, file) {
  try {
    const r = spawnSync(ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { encoding: 'utf8', windowsHide: true });
    if (r.status !== 0 || !r.stdout) return null;
    const j = JSON.parse(r.stdout);
    const st = (j.streams || []).find((s) => s.codec_type === 'audio') || {};
    return { codec: st.codec_name, sampleRate: st.sample_rate, bits: st.bits_per_raw_sample || st.bits_per_sample || null, duration: parseFloat((j.format && j.format.duration) || '0') };
  } catch { return null; }
}

module.exports = { lookupDeezer, lookupDeezerByIsrc, downloadCover, losslessResolve, probeInfo, norm };

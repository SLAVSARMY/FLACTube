// Вшитый источник: YouTube Music через yt-dlp.
// Порядок аудиопотоков: 258/256/141 — AAC до 320/256 kbps (когда YouTube их
// отдаёт — обычно с premium-куками), 251 — Opus ~160 kbps, 140 — AAC 128 kbps,
// затем общий bestaudio. Премиум-куки подставляет DownloadManager.
globalThis.resolve = async (ctx) => {
  if (ctx.source !== 'youtube' || !/^[\w-]{11}$/.test(String(ctx.videoId || ''))) return null;
  return {
    kind: 'command',
    url: 'https://www.youtube.com/watch?v=' + ctx.videoId,
    formatChain: '258/256/141/251/140/bestaudio/bestaudio*',
  };
};

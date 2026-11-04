// Вшитый источник: SoundCloud через yt-dlp (страница трека импортируется
// заранее через панель — здесь только прямая ссылка).
globalThis.resolve = async (ctx) => {
  if (ctx.source !== 'soundcloud') return null;
  if (!/^https:\/\/(www\.|m\.)?soundcloud\.com\//.test(String(ctx.pageUrl || ''))) return null;
  if (!/^[\w-]{4,32}$/.test(String(ctx.videoId || ''))) return null;
  return { kind: 'command', url: ctx.pageUrl, formatChain: 'bestaudio/best' };
};

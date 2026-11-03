// Сброс Google/YT-куки в профиле persist:ytm: после отказов логина гугл
// помечает сессию «небезопасной» в куках, и вход не проходит даже с починенным
// клиентом. Запуск (приложение должно быть ЗАКРЫТО):
//   npx electron scripts/reset-google-cookies.js
const { app, session } = require('electron');

// packaged exe живёт в %APPDATA%/FLACTube (productName); dev-запуск electron
// может выбрать другую папку — привязываемся к packaged-профилю жёстко
app.setPath('userData', process.env.APPDATA + '\\FLACTube');

const WIPE = /(google|youtube|gstatic|googleapis|doubleclick)\.(com|ru)$/i;

app.whenReady().then(async () => {
  const ses = session.fromPartition('persist:ytm');
  const all = await ses.cookies.get({});
  let removed = 0;
  for (const c of all) {
    const host = String(c.domain || '').replace(/^\./, '');
    if (WIPE.test(host)) {
      const url = 'https://' + host + (c.path || '/');
      try { await ses.cookies.remove(url, c.name); removed++; } catch {}
    }
  }
  console.log(`куки гугла удалено: ${removed} из ${all.length}`);
  // заодно чистим кэш — в нём могут лежать страницы отказа
  await ses.clearCache().catch(() => {});
  console.log('кэш сессии очищен');
  app.quit();
}).catch((e) => { console.error(e); app.exit(1); });

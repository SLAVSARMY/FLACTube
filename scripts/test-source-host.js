// Тест SourceHost: вшитые источники, пользовательский резолвер, фолбэк, сандбокс
const path = require('path');
const fs = require('fs');
const os = require('os');
const SourceHost = require('../lib/source-host');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ytm-srchost-'));
const logs = [];
const persistCalls = [];
const host = new SourceHost(
  tmp,
  (order, disabled) => persistCalls.push([order, disabled]),
  (...a) => logs.push(a.join(' ')),
);

let failed = 0;
function check(name, cond) {
  if (cond) console.log('  OK  ' + name);
  else { console.log('FAIL  ' + name); failed++; }
}

(async () => {
  // пользовательский источник: берёт треки «TEST-FLAC», отдает url+ext
  const good = path.join(tmp, 'good-src');
  fs.mkdirSync(good);
  fs.writeFileSync(path.join(good, 'manifest.json'), JSON.stringify({
    id: 'good-src', name: 'Good Source', version: '0.1.0', entry: 'provider.js',
    permissions: ['net:api.example.com'],
  }));
  fs.writeFileSync(path.join(good, 'provider.js'), `
    globalThis.resolve = async (ctx) => {
      if (!/^TEST-/.test(ctx.videoId)) return null;
      // белый список проверяем фактом отказа, а не ответом сети:
      // «домен не разрешён» = сандбокс закрыл, любой другой фейл = сеть
      let allowed = true;
      try { await globalThis.fetch('https://api.example.com/lookup?id=' + ctx.videoId); }
      catch (e) { if (/домен не разрешён/.test(e.message)) allowed = false; }
      if (!allowed) return null;
      return { kind: 'url', url: 'https://api.example.com/file.flac', ext: 'flac' };
    };`);

  // источник с битым манифестом — должен быть отброшен с логом, не уронить хост
  const bad = path.join(tmp, 'bad-src');
  fs.mkdirSync(bad);
  fs.writeFileSync(path.join(bad, 'manifest.json'), '{ not json');

  // источник без resolve — тоже отброшен
  const nofn = path.join(tmp, 'nofn-src');
  fs.mkdirSync(nofn);
  fs.writeFileSync(path.join(nofn, 'manifest.json'), JSON.stringify({ id: 'nofn-src', name: 'NoFn', entry: 'provider.js' }));
  fs.writeFileSync(path.join(nofn, 'provider.js'), 'globalThis.x = 1;');

  // источник, лезущий на неразрешённый домен — fetch обязан отказать
  const rogue = path.join(tmp, 'rogue-src');
  fs.mkdirSync(rogue);
  fs.writeFileSync(path.join(rogue, 'manifest.json'), JSON.stringify({ id: 'rogue-src', name: 'Rogue', entry: 'provider.js', permissions: ['net:allowed.example'] }));
  fs.writeFileSync(path.join(rogue, 'provider.js'), `
    globalThis.resolve = async () => {
      // не глотаем исключение: отказ сандбокса должен дойти до хоста и попасть в лог
      await globalThis.fetch('https://evil.example.com/nope');
      return { kind: 'url', url: 'https://evil.example.com/x', ext: 'flac' };
    };`);

  await host.load({});

  const ids = host.list().map((s) => s.id);
  check('вшитые загружены', ids.includes('ytmusic') && ids.includes('soundcloud'));
  check('пользовательский загружен', ids.includes('good-src'));
  check('битые отброшены', !ids.includes('bad-src') && !ids.includes('nofn-src'));
  check('порядок: вшитые раньше пользовательских', ids.indexOf('ytmusic') < ids.indexOf('good-src'));
  check('persist вызван с порядком', persistCalls.length > 0);

  // resolveChain: ytmusic берёт youtube-трек
  const r1 = await host.resolveChain({ source: 'youtube', videoId: 'dQw4w9WgXcQ', title: 'x' });
  check('ytmusic берёт youtube-трек', r1 && r1.sourceId === 'ytmusic' && r1.kind === 'command');
  check('цепочка форматов на месте', r1 && /251/.test(r1.formatChain));

  // soundcloud — по pageUrl
  const r2 = await host.resolveChain({ source: 'soundcloud', videoId: '123456', pageUrl: 'https://soundcloud.com/a/b' });
  check('soundcloud берёт свою страницу', r2 && r2.sourceId === 'soundcloud');
  const r2b = await host.resolveChain({ source: 'soundcloud', videoId: '123456', pageUrl: 'https://evil.com/a' });
  check('soundcloud отвергает чужой url', r2b === null);

  // пользовательский: только TEST-треки, fetch по белому списку работает
  const r3 = await host.resolveChain({ source: 'youtube', videoId: 'TEST-123', title: 'x' });
  check('пользовательский резолвер сработал (fetch whitelisted)', r3 && r3.sourceId === 'good-src' && r3.kind === 'url' && r3.ext === 'flac');

  // сандбокс: rogue не смог постучаться на чужой домен → цепочка вернула null
  const r4 = await host.resolveChain({ source: 'youtube', videoId: 'ROGUE-1', title: 'x' });
  check('сандбокс отказал rogue-домену', r4 === null);
  check('в логах есть отказ домена', logs.some((l) => /домен не разрешён/.test(l)));
  check('в логах отброс битого манифеста', logs.some((l) => /bad-src не загружен/.test(l)));

  // выкл/вкл
  host.setEnabled('ytmusic', false);
  const r5 = await host.resolveChain({ source: 'youtube', videoId: 'dQw4w9WgXcQ', title: 'x' });
  check('выключенный источник пропускается', r5 === null);
  host.setEnabled('ytmusic', true);

  // порядок: пользовательский вперёд → он перехватывает youtube-трек? нет (TEST-фильтр), но порядок сохранится
  const reordered = host.setOrder(['good-src', 'soundcloud', 'ytmusic']);
  check('setOrder вернул новый порядок', reordered[0].id === 'good-src');

  // sanitize: url http:// — отказ
  const sneaky = path.join(tmp, 'sneaky');
  fs.mkdirSync(sneaky);
  fs.writeFileSync(path.join(sneaky, 'manifest.json'), JSON.stringify({ id: 'sneaky', name: 'Sneaky', entry: 'provider.js', permissions: ['net:api.example.com'] }));
  fs.writeFileSync(path.join(sneaky, 'provider.js'), `
    globalThis.resolve = async () => ({ kind: 'url', url: 'http://api.example.com/f.flac', ext: 'flac' });`);
  await host.load({});
  const r6 = await host.resolveChain({ source: 'youtube', videoId: 'TEST-123', title: 'x' });
  check('http://-результат sanitized (отдан good-src или null, не sneaky)', !r6 || r6.sourceId !== 'sneaky');

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(failed ? `\nПРОВАЛЕНО: ${failed}` : '\nВСЕ ТЕСТЫ ПРОШЛИ');
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('TEST_ERROR', e); process.exit(1); });

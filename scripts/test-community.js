// Диагностика community-источника: что реально отвечает сервер.
const path = require('path');
const { CommunityClient, VERIFY_BASE, TIDAL_BASE } = require('../lib/community');

const sessionPath = path.join(process.env.APPDATA, 'YT Music Desktop', 'community_session.json');
const c = new CommunityClient(sessionPath, () => {});

(async () => {
  c.load();
  console.log('сессия валидна:', c.valid(), '| до', c.record.expires_at);

  // 1) verify-сервер жив?
  try {
    const r = await fetch(VERIFY_BASE + '/bootstrap?install_id=' + c.record.install_id + '&app_version=1.4.2&platform=desktop', {
      signal: AbortSignal.timeout(15000), headers: { 'User-Agent': 'SpotiFLAC/1.4.2' },
    });
    console.log('bootstrap:', r.status);
  } catch (e) { console.log('bootstrap: недоступен —', e.message); }

  // 2) настоящий вызов /api/dl с подписью
  try {
    const res = await c.tidal('GBAYE0601498', '24');
    console.log('tidal OK:', res.quality, String(res.url).slice(0, 80));
  } catch (e) {
    console.log('tidal error:', e.message, e.code || '');
  }
  try {
    const res = await c.qobuz('GBAYE0601498', '16');
    console.log('qobuz OK:', res.quality, String(res.url).slice(0, 80));
  } catch (e) {
    console.log('qobuz error:', e.message, e.code || '');
  }
  process.exit(0);
})();

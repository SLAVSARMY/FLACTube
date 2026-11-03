// Проба всех трёх источников разными ISRC.
const path = require('path');
const { CommunityClient } = require('../lib/community');

const c = new CommunityClient(path.join(process.env.APPDATA, 'YT Music Desktop', 'community_session.json'), () => {});
c.load();

const ISRCs = ['GBAYE0601498', 'GBAHT1700105', 'USUM71703861']; // Astley, Sheeran, Despacito
(async () => {
  for (const isrc of ISRCs) {
    for (const [name, fn] of [['tidal', (q) => c.tidal(isrc, q)], ['qobuz', (q) => c.qobuz(isrc, q)], ['amazon', (q) => c.amazon(isrc, q)]]) {
      try {
        const res = await fn('24');
        console.log(isrc, name, '→ OK', res.quality);
        process.exit(0);
      } catch (e) { console.log(isrc, name, '→', e.code || '', e.message.slice(0, 90)); }
    }
  }
  process.exit(0);
})();

// Клиент community-серверов SpotiFLAC (протокол из их открытого репо).
// Одноразовая верификация в браузере (как у всех пользователей SpotiFLAC):
//   bootstrap → challenge в браузере → grant на локальный callback → сессия.
// Дальше запросы подписываются HMAC (rolling key) — честный клиент.
const http = require('http');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const VERIFY_BASE = 'https://verify.spotbye.qzz.io';
const TIDAL_BASE = 'https://tdl-oss.spotbye.qzz.io';
const QOBUZ_BASE = 'https://qbz-oss.spotbye.qzz.io';
const AMAZON_BASE = 'https://amz-oss.spotbye.qzz.io';
const APP_VERSION = '1.4.2';
const UA = 'SpotiFLAC/' + APP_VERSION;

const randHex = (n) => crypto.randomBytes(n).toString('hex');

class CommunityClient {
  constructor(sessionPath, openBrowser) {
    this.sessionPath = sessionPath;
    this.openBrowser = openBrowser || (() => {});
    this.record = null;
    this.cooldownUntil = 0;
  }

  load() {
    try { this.record = JSON.parse(fs.readFileSync(this.sessionPath, 'utf8')); } catch { this.record = {}; }
    if (!this.record.install_id) {
      this.record.install_id = randHex(16);
      this.save();
    }
    return this.record;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.sessionPath), { recursive: true });
      fs.writeFileSync(this.sessionPath, JSON.stringify(this.record, null, 2));
    } catch {}
  }

  valid() {
    const r = this.record || {};
    if (!r.session_id || !r.session_secret || !r.expires_at) return false;
    const exp = Date.parse(r.expires_at);
    return Number.isFinite(exp) && exp > Date.now() + 5 * 60 * 1000;
  }

  hasSession() {
    this.load();
    return this.valid();
  }

  // Верификация: локальный callback + challenge в браузере пользователя
  verify() {
    return new Promise((resolve, reject) => {
      this.load();
      const state = randHex(16);
      let done = false;
      const finish = (err, grant) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { server.close(); } catch {}
        if (err) reject(err);
        else resolve(grant);
      };
      const server = http.createServer((req, res) => {
        const u = new URL(req.url, 'http://127.0.0.1');
        if (u.pathname !== '/session-grant') { res.writeHead(404); res.end(); return; }
        if (u.searchParams.get('state') !== state) {
          res.writeHead(400); res.end('bad state'); return;
        }
        const g = (u.searchParams.get('grant') || '').trim();
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end('<!doctype html><html><head><meta charset="utf-8"><title>Verified</title></head><body style="background:#000;color:#fff;font:16px sans-serif;display:grid;place-items:center;height:100vh"><h1>✅ Проверка пройдена — можно закрыть вкладку</h1></body></html>');
        finish(null, g);
      });
      server.on('error', (e) => finish(e));
      server.listen(0, '127.0.0.1', async () => {
        try {
          const port = server.address().port;
          const cb = `http://127.0.0.1:${port}/session-grant?state=${state}`;
          const r = await fetch(`${VERIFY_BASE}/bootstrap?install_id=${this.record.install_id}&app_version=${APP_VERSION}&platform=desktop`, {
            signal: AbortSignal.timeout(15000),
            headers: { 'User-Agent': UA },
          });
          if (!r.ok) { finish(new Error('bootstrap HTTP ' + r.status)); return; }
          const { challenge_url: challengeUrl } = await r.json();
          if (!challengeUrl || !challengeUrl.startsWith('https://')) { finish(new Error('плохой challenge URL')); return; }
          const sep = challengeUrl.includes('?') ? '&' : '?';
          this.openBrowser(challengeUrl + sep + 'cb=' + encodeURIComponent(cb));
        } catch (e) { finish(e); }
      });
      const timer = setTimeout(() => finish(new Error('верификация не пройдена за 5 минут')), 5 * 60 * 1000);
    }).then((grant) => this.exchange(grant));
  }

  async exchange(grant) {
    const r = await fetch(VERIFY_BASE + '/session/exchange', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ grant, install_id: this.record.install_id, app_version: APP_VERSION, platform: 'desktop' }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error('session exchange HTTP ' + r.status + ': ' + t.slice(0, 200));
    }
    const j = await r.json();
    if (!j.session_id || !j.session_secret || !j.expires_at) throw new Error('неполный ответ exchange');
    this.record.session_id = j.session_id;
    this.record.session_secret = j.session_secret;
    this.record.expires_at = j.expires_at;
    this.save();
    return j;
  }

  async ensure() {
    this.load();
    if (this.valid()) return this.record;
    const grant = await this.verify();
    return this.exchange(grant) && this.record;
  }

  clearSession() {
    this.load();
    this.record.session_id = '';
    this.record.session_secret = '';
    this.record.expires_at = '';
    this.save();
  }

  // Подпись запроса (SPOTIFLAC-HMAC-V1, rolling key по 5-минутным окнам)
  sign(method, escapedPath, bodyStr) {
    const r = this.record;
    const bodyHash = crypto.createHash('sha256').update(bodyStr || '').digest('hex');
    const timestamp = new Date().toISOString(); // YYYY-MM-DDTHH:MM:SS.sssZ
    const nonce = randHex(12);
    const window = Math.floor(Math.floor(Date.now() / 1000) / 300);
    const rollingKey = crypto.createHmac('sha256', r.session_secret)
      .update(`${window}:${r.session_id}`).digest();
    const signingInput = [
      'SPOTIFLAC-HMAC-V1', method, escapedPath, '', bodyHash,
      timestamp, nonce, r.session_id, APP_VERSION, 'desktop',
    ].join('\n');
    const signature = crypto.createHmac('sha256', rollingKey).update(signingInput).digest('base64url');
    return {
      'X-Sig-Session': r.session_id,
      'X-Sig-Timestamp': timestamp,
      'X-Sig-Nonce': nonce,
      'X-Sig-Body-SHA256': bodyHash,
      'X-Sig-Signature': signature,
      'X-Sig-App-Version': APP_VERSION,
      'X-Sig-Platform': 'desktop',
      'User-Agent': UA,
    };
  }

  // POST {base}/api/dl {id, quality} → {quality, url, lyric}
  async dl(base, id, quality) {
    if (Date.now() < this.cooldownUntil) {
      throw new Error('community API на кулдауне ещё ' + Math.ceil((this.cooldownUntil - Date.now()) / 1000) + ' с');
    }
    await this.ensure();
    const body = JSON.stringify({ id: String(id), quality: quality === '24' ? '24' : '16' });
    const u = new URL(base + '/api/dl');
    const headers = this.sign('POST', u.pathname, body);
    headers['Content-Type'] = 'application/json';
    headers['Accept'] = 'application/json, text/plain, */*';
    const r = await fetch(u, { method: 'POST', headers, body, signal: AbortSignal.timeout(60000) });
    if (r.status === 503) {
      const ra = parseInt(r.headers.get('retry-after') || '0', 10);
      this.cooldownUntil = Date.now() + (ra || 30) * 1000;
      throw new Error('community на кулдауне (' + (ra || 30) + ' с)');
    }
    if (r.status === 401 || r.status === 428) {
      const t = await r.text().catch(() => '');
      throw new Error('подпись/сессия отклонена (' + r.status + '): ' + t.slice(0, 150));
    }
    if (r.status === 404) {
      const e = new Error('трека нет в источнике (404)');
      e.code = 'NOT_FOUND';
      throw e;
    }
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      throw new Error('community HTTP ' + r.status + ': ' + t.slice(0, 120));
    }
    const j = await r.json();
    if (!j.url) {
      const e = new Error('трека нет в источнике');
      e.code = 'NOT_FOUND';
      throw e;
    }
    return { url: j.url, quality: j.quality || quality, lyric: j.lyric || '' };
  }

  tidal(id, quality) { return this.dl(TIDAL_BASE, id, quality); }
  qobuz(id, quality) { return this.dl(QOBUZ_BASE, id, quality); }
  amazon(id, quality) { return this.dl(AMAZON_BASE, id, quality); }
}

module.exports = { CommunityClient, VERIFY_BASE, TIDAL_BASE };

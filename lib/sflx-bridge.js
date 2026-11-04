// ── Хост-сторона моста к mornye-расширению ──────────────────────────────────
// Держит child-процесс (ELECTRON_RUN_AS_NODE + sflx-runner.js), гоняет RPC:
// запросы по stdin, ответы/логи/прогресс — по stdout. Один child на источник,
// переживает вызовы; при краше — чистится и поднимается заново при следующем.
// Отмена: kill() — child умирает вместе с sync-конвейером расширения.

const { spawn } = require('child_process');
const path = require('path');
const readline = require('readline');

const CALL_TIMEOUT_MS = 10 * 60 * 1000; // потолок одного вызова (download HLS)

class SflxBridge {
  constructor(dir, log) {
    this.dir = dir;
    this.log = log || (() => {});
    this.child = null;
    this.rl = null;
    this.seq = 0;
    this.pending = new Map(); // id → { resolve, reject, timer, onProgress }
    this.fns = new Set();
    this.dead = false;
  }

  _spawn() {
    if (this.child && !this.child.killed && this.child.exitCode === null) return;
    this.dead = false;
    this.pending.forEach((p) => p.reject(new Error('мост перезапускается')));
    this.pending.clear();
    if (this.rl) { try { this.rl.close(); } catch {} this.rl = null; }

    const child = spawn(process.execPath, [path.join(__dirname, 'sflx-runner.js'), this.dir], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stderr.on('data', (d) => this.log(`[stderr] ${String(d).trim().slice(0, 300)}`));
    child.on('exit', (code) => {
      const pend = [...this.pending.values()];
      this.pending.clear();
      for (const p of pend) {
        clearTimeout(p.timer);
        p.reject(new Error('расширение завершилось (код ' + code + ')'));
      }
      this.child = null;
    });

    this.rl = readline.createInterface({ input: child.stdout });
    this.rl.on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      if (msg.ready) { this.fns = new Set(msg.fns || []); return; }
      if (msg.log) { this.log(`[${msg.log[0]}] ${msg.log[1]}`); return; }
      if (msg.id !== undefined && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(p.timer);
        if (msg.ok) p.resolve(msg.result);
        else p.reject(new Error(String(msg.error || 'ошибка расширения')));
        return;
      }
      if (msg.progress !== undefined) {
        // прогресс идёт без id — рассылаем последнему активному вызову
        for (const p of this.pending.values()) {
          if (p.onProgress) { try { p.onProgress(msg.progress); } catch {} }
        }
      }
    });
  }

  call(fn, args, onProgress) {
    this._spawn();
    if (this.dead) throw new Error('мост мёртв');
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        this.kill(); // sync-конвейер нельзя прервать иначе
        reject(new Error('таймаут вызова ' + fn));
      }, CALL_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer, onProgress });
      try {
        this.child.stdin.write(JSON.stringify({ id, fn, args }) + '\n');
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error('мост не отвечает: ' + e.message));
      }
    });
  }

  has(fn) { return this.fns.has(fn); }

  kill() {
    if (this.child) { try { this.child.kill(); } catch {} }
    this.child = null;
    if (this.rl) { try { this.rl.close(); } catch {} this.rl = null; }
  }
}

module.exports = { SflxBridge };

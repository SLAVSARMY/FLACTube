// Пользовательские плагины: *.json в папке <userData>/plugins.
//   name, description           — подпись в панели
//   blockUrls: ["regex", ...]   — добавляют правила сетевому блокировщику
//   css: "..."                  — стили, вшиваемые в страницу
//   hide: ["селектор", ...]     — display:none!important
//   remove: ["селектор", ...]   — удаляют узлы из DOM
//   autoDismiss: [{match, click}] — автоклик кнопки в диалогах по регексам
//   js: "..."                   — произвольный код, выполняется на странице
//                                 в изолированном мире (DOM общий, node недоступен).
//                                 Получает api: { toast, download, toggleDrawer,
//                                 onTick(fn), name }
// Битый JSON не валит приложение — файл помечается ошибкой и пропускается.
const fs = require('fs');
const path = require('path');

const CAPS = {
  files: 50, blockUrls: 100, hide: 100, remove: 100, dismiss: 50,
  css: 65536, js: 262144, selector: 200, pattern: 300, text: 200,
};

class Plugins {
  constructor(dir) {
    this.dir = dir;
    this.list = []; // [{file, name, description, ok, error}]
    this.merged = { css: '', hide: [], remove: [], dismiss: [], blockUrls: [], js: [] };
  }

  load() {
    this.list = [];
    const m = { css: '', hide: [], remove: [], dismiss: [], blockUrls: [], js: [] };
    let files = [];
    try {
      files = fs.readdirSync(this.dir).filter((f) => f.toLowerCase().endsWith('.json')).sort();
    } catch {}
    for (const f of files.slice(0, CAPS.files)) {
      const entry = { file: f, name: f.replace(/\.json$/i, ''), description: '', ok: false, error: '' };
      try {
        const j = JSON.parse(fs.readFileSync(path.join(this.dir, f), 'utf8'));
        if (!j || typeof j !== 'object' || Array.isArray(j)) throw new Error('корень JSON — должен быть объект');
        entry.name = String(j.name || entry.name).slice(0, 60);
        entry.description = String(j.description || '').slice(0, CAPS.text);

        for (const s of Array.isArray(j.blockUrls) ? j.blockUrls.slice(0, CAPS.blockUrls) : []) {
          const src = String(s).slice(0, CAPS.pattern);
          if (!src) continue;
          // не регекс — считаем подстрокой (экранируем)
          let re;
          try { re = new RegExp(src, 'i'); }
          catch { re = new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
          m.blockUrls.push(re);
        }
        if (typeof j.css === 'string' && j.css && j.css.length <= CAPS.css) {
          m.css += `\n/* ${entry.name} */\n${j.css}`;
        }
        if (typeof j.js === 'string' && j.js.trim() && j.js.length <= CAPS.js) {
          m.js.push({ name: entry.name, code: j.js });
        }
        for (const key of ['hide', 'remove']) {
          for (const s of Array.isArray(j[key]) ? j[key].slice(0, CAPS[key]) : []) {
            const sel = String(s).trim().slice(0, CAPS.selector);
            if (sel && !/[{}]/.test(sel)) m[key].push(sel); // селектор без CSS-тела
          }
        }
        for (const r of Array.isArray(j.autoDismiss) ? j.autoDismiss.slice(0, CAPS.dismiss) : []) {
          const match = r && String(r.match || '').slice(0, CAPS.text);
          const click = r && String(r.click || '').slice(0, CAPS.text);
          if (!match || !click) continue;
          try { m.dismiss.push({ match: new RegExp(match, 'i'), click: new RegExp(click, 'i') }); } catch {}
        }
        entry.ok = true;
      } catch (err) {
        entry.error = String((err && err.message) || 'ошибка').slice(0, 120);
      }
      this.list.push(entry);
    }
    this.merged = m;
    return { count: this.list.length, ok: this.list.filter((p) => p.ok).length };
  }
}

module.exports = Plugins;

const fs = require('fs');
const path = require('path');

function configPath() {
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'config.json');
}

function loadConfig() {
  try { return JSON.parse(fs.readFileSync(configPath(), 'utf8')); } catch { return {}; }
}

function saveConfig(patch) {
  const cfg = { ...loadConfig(), ...patch };
  try {
    fs.mkdirSync(path.dirname(configPath()), { recursive: true });
    fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
  } catch {}
  return cfg;
}

module.exports = { loadConfig, saveConfig };

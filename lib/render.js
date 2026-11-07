// 长图渲染：手写 HTML → Edge/Chrome 无头截图。
//
// 为什么不用 canvas/puppeteer：
//   Electron 主进程里再装一套原生 canvas 很容易和 DSH 自身的 node 版本打架，
//   而 Edge 是 Windows 预装的，`--screenshot` 已经够用，零依赖。
//
// 两趟渲染：先 --dump-dom 量出内容高度，再按该高度截图，
// 否则固定 window-size 会在长图底部留一大块空白。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { rankedTierOf } from './dakanu.js';

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
];

export function findBrowser(override) {
  if (override && fs.existsSync(override)) return override;
  const fromEnv = process.env.KLBQ_BROWSER;
  if (fromEnv && fs.existsSync(fromEnv)) return fromEnv;
  for (const p of BROWSERS) if (fs.existsSync(p)) return p;
  return null;
}

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pct = (v) => `${((Number(v) || 0) * 100).toFixed(1)}%`;
const num = (v, digits = 0) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '-';
  return digits ? n.toFixed(digits) : String(Math.round(n));
};
const fmtDuration = (s) => {
  const sec = Number(s) || 0;
  return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
};
const fmtTime = (unix) => {
  const t = Number(unix);
  if (!Number.isFinite(t) || t <= 0) return '-';
  const d = new Date(t * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** 生成整张长图的 HTML */
export function buildHtml(profile, { width = 900, maxMatches = 10 } = {}) {
  const p = profile ?? {};
  const player = p.player ?? {};
  const presence = p.presence ?? {};
  const summary = p.summary ?? {};
  const modes = Array.isArray(p.modes) ? p.modes : [];
  const roles = Array.isArray(p.roles) ? [...p.roles].sort((a, b) => (b.count ?? 0) - (a.count ?? 0)) : [];
  const matches = Array.isArray(p.matches) ? p.matches.slice(0, maxMatches) : [];
  const roleName = new Map(roles.map((r) => [String(r.roleId), r.name]));

  // 排位：当前 / 历史最高
  const curTier = rankedTierOf(p.rank?.segment);
  const topTier = rankedTierOf(p.rank?.historicalSegment);
  const curName = curTier ? (curTier.division ? `${curTier.name} ${curTier.division}` : curTier.name) : '未定级';
  const topName = topTier ? (topTier.division ? `${topTier.name} ${topTier.division}` : topTier.name) : '未定级';
  const curColor = curTier?.color ?? '#9aa7b5';
  const topColor = topTier?.color ?? '#cdd8ee';
  const online = presence.state === 'online' || presence.statusText === 'online';

  const statCell = (label, value, sub = '') => `
    <div class="cell">
      <div class="cell-label">${esc(label)}</div>
      <div class="cell-value">${esc(value)}</div>
      ${sub ? `<div class="cell-sub">${esc(sub)}</div>` : ''}
    </div>`;

  const modeRows = modes.map((m) => `
    <div class="mode-row">
      <div class="mode-name">${esc(m.label ?? m.mode ?? '-')}</div>
      <div class="mode-bar"><i style="width:${Math.min(100, (Number(m.winRate) || 0) * 100).toFixed(1)}%"></i></div>
      <div class="mode-win">${pct(m.winRate)}</div>
      <div class="mode-kda">KDA ${num(m.kda, 2)}</div>
      <div class="mode-dmg">均伤 ${num(m.avgDamage)}</div>
      <div class="mode-rounds">${num(m.rounds)} 场</div>
    </div>`).join('');

  const roleRows = roles.slice(0, 8).map((r) => `
    <div class="role-row">
      <div class="role-name">${esc(r.name ?? r.roleId)}</div>
      <div class="role-bar"><i style="width:${Math.min(100, (Number(r.winRate) || 0) * 100).toFixed(1)}%"></i></div>
      <div class="role-win">${pct(r.winRate)}</div>
      <div class="role-kd">KD ${num(r.kd, 2)}</div>
      <div class="role-dmg">均伤 ${num(r.avgDamage)}</div>
      <div class="role-count">${num(r.count)} 场</div>
    </div>`).join('');

  const matchRows = matches.map((m) => {
    const win = m.result === 'win';
    const delta = Number(m.divisionScoreDelta);
    const deltaTxt = Number.isFinite(delta) && delta !== 0 ? `${delta > 0 ? '+' : ''}${delta}` : '';
    return `
    <div class="match-row ${win ? 'win' : 'lose'}">
      <div class="m-result">${win ? '胜' : '负'}</div>
      <div class="m-mode">${esc(m.modeLabel ?? m.mode ?? '-')}</div>
      <div class="m-role">${esc(roleName.get(String(m.roleId)) ?? '-')}</div>
      <div class="m-kda">${num(m.kills)}/${num(m.deaths)}/${num(m.assists)}</div>
      <div class="m-score">${num(m.myScore)}:${num(m.opponentScore)}</div>
      <div class="m-dur">${fmtDuration(m.durationSeconds)}</div>
      <div class="m-delta">${esc(deltaTxt)}</div>
      <div class="m-time">${fmtTime(m.playedAt)}</div>
    </div>`;
  }).join('');

  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8">
<style>
  * { box-sizing: border-box; }
  body { margin: 0; width: ${width}px; background: #0d1220; color: #e8eefc;
         font-family: "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", sans-serif; }
  .wrap { padding: 28px 32px 34px; }
  .head { display: flex; align-items: flex-start; justify-content: space-between; }
  .nick { font-size: 40px; font-weight: 700; letter-spacing: .5px; line-height: 1.1; }
  .sub { margin-top: 10px; font-size: 16px; color: #8fa0bf; }
  .dot { display: inline-block; width: 9px; height: 9px; border-radius: 50%; margin-right: 6px;
         background: ${online ? '#3ddc84' : '#6b7280'}; }
  .badge { padding: 12px 18px; border-radius: 12px; text-align: right; min-width: 240px;
           border: 1px solid ${curColor}55; background: ${curColor}14; }
  .badge-row { display: flex; align-items: baseline; justify-content: space-between; gap: 14px; }
  .badge-row + .badge-row { margin-top: 6px; }
  .badge-label { font-size: 13px; color: #8fa0bf; letter-spacing: .5px; }
  .badge-top { font-size: 20px; font-weight: 600; }
  .badge-cur { font-size: 28px; font-weight: 700; }
  .badge .sc { margin-top: 8px; font-size: 13px; color: #8fa0bf; text-align: right; }
  .card { margin-top: 22px; background: #141c2f; border: 1px solid #1f2a44; border-radius: 16px; padding: 18px 20px; }
  .card h3 { margin: 0 0 14px; font-size: 17px; font-weight: 600; color: #9fb0cc; letter-spacing: 1px; }
  .grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 14px; }
  .cell { background: #101728; border-radius: 12px; padding: 14px 16px; }
  .cell-label { font-size: 13px; color: #7f8fad; }
  .cell-value { margin-top: 6px; font-size: 28px; font-weight: 700; color: #ffffff; }
  .cell-sub { margin-top: 2px; font-size: 12px; color: #6f80a0; }
  .mode-row, .role-row { display: grid; grid-template-columns: 96px 1fr 72px 96px 108px 64px;
                          align-items: center; gap: 10px; padding: 9px 0; border-top: 1px solid #1b2437; font-size: 14px; }
  .mode-row:first-child, .role-row:first-child { border-top: none; }
  .mode-name, .role-name { color: #dfe8ff; font-weight: 600; }
  .mode-bar, .role-bar { height: 8px; background: #1d2740; border-radius: 6px; overflow: hidden; }
  .mode-bar i, .role-bar i { display: block; height: 100%; border-radius: 6px;
      background: linear-gradient(90deg, #3a8dff, #43e0c8); }
  .mode-win, .role-win { color: #43e0c8; font-weight: 600; text-align: right; }
  .mode-kda, .mode-dmg, .mode-rounds, .role-kd, .role-dmg, .role-count { color: #93a4c4; text-align: right; }
  .match-row { display: grid; grid-template-columns: 44px 92px 76px 92px 62px 54px 52px 1fr;
                align-items: center; gap: 8px; padding: 8px 0; border-top: 1px solid #1b2437; font-size: 14px; }
  .match-row:first-child { border-top: none; }
  .m-result { width: 32px; text-align: center; border-radius: 6px; font-weight: 700; font-size: 13px; padding: 3px 0; }
  .match-row.win .m-result { background: #1d4f3a; color: #43e0c8; }
  .match-row.lose .m-result { background: #4a2130; color: #ff7a94; }
  .m-mode { color: #cfdaf2; }
  .m-role { color: #93a4c4; }
  .m-kda { color: #dfe8ff; font-weight: 600; }
  .m-score, .m-dur { color: #8b9cbb; }
  .m-delta { color: #7fd6a8; text-align: right; }
  .match-row.lose .m-delta { color: #ff92a6; }
  .m-time { color: #6f80a0; text-align: right; }
  .foot { margin-top: 20px; font-size: 12px; color: #5d6a83; display: flex; justify-content: space-between; }
</style></head>
<body><div class="wrap">
  <div class="head">
    <div>
      <div class="nick">${esc(player.nickname ?? '-')}</div>
      <div class="sub">
        <span class="dot"></span>${online ? '在线' : '离线'}
        ${presence.regionLabel ? ` · ${esc(presence.regionLabel)}` : ''}
        · Lv.${num(player.level)}
      </div>
    </div>
    <div class="badge">
      <div class="badge-row">
        <span class="badge-label">历史最高</span>
        <span class="badge-top" style="color:${topColor}">${esc(topName)}</span>
      </div>
      <div class="badge-row">
        <span class="badge-label">当前段位</span>
        <span class="badge-cur" style="color:${curColor}">${esc(curName)}</span>
      </div>
      ${p.rank?.divisionScore ? `<div class="sc">段位分 ${num(p.rank.divisionScore)}</div>` : ''}
    </div>
  </div>

  <div class="card">
    <h3>总览</h3>
    <div class="grid">
      ${statCell('场次', num(summary.rounds), `${num(summary.wins)} 胜 ${num(summary.losses)} 负`)}
      ${statCell('胜率', pct(summary.winRate), '')}
      ${statCell('KDA', num(summary.kda, 2), `KD ${num(summary.kd, 2)}`)}
      ${statCell('场均伤害', num(summary.avgDamage), `总伤害 ${num(summary.damage)}`)}
      ${statCell('场均击杀', num(summary.avgKill, 1), `助攻 ${num(summary.avgAssist, 1)}`)}
      ${statCell('MVP 率', pct(summary.mvpRate), `爆头率 ${pct(summary.headshotRate)}`)}
    </div>
  </div>

  ${modeRows ? `<div class="card"><h3>模式表现</h3>${modeRows}</div>` : ''}
  ${roleRows ? `<div class="card"><h3>角色表现（按场次）</h3>${roleRows}</div>` : ''}
  ${matchRows ? `<div class="card"><h3>最近对局</h3>${matchRows}</div>` : ''}

  <div class="foot">
    <span>数据来源 dakanu.com · 仅供娱乐参考</span>
    <span>${fmtTime(Math.floor((player.queriedAt ?? Date.now()) / 1000))}</span>
  </div>
  <div id="__h" style="display:none"></div>
  <script>document.getElementById('__h').textContent = String(Math.ceil(document.body.getBoundingClientRect().height));</script>
</div></body></html>`;
}

function runBrowser(bin, args, { timeoutMs = 60000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: timeoutMs, windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error && !stdout) {
        return reject(new Error(`${path.basename(bin)} 执行失败：${error.message}${stderr ? ` / ${String(stderr).slice(0, 200)}` : ''}`));
      }
      resolve({ stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
    });
  });
}

/** HTML → PNG（两趟：先量高度，再按高度截图） */
export async function renderPng(html, { width = 900, timeoutMs = 90000, browserPath } = {}) {
  const bin = findBrowser(browserPath);
  if (!bin) throw new Error('没找到 Edge/Chrome，无法渲染图片（可用环境变量 KLBQ_BROWSER 指定）');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-klbq-'));
  const htmlFile = path.join(dir, 'card.html');
  const pngFile = path.join(dir, 'card.png');
  const profileDir = path.join(dir, 'profile');
  fs.writeFileSync(htmlFile, html, 'utf8');
  const url = 'file:///' + htmlFile.replace(/\\/g, '/');
  const base = ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-extensions',
    '--hide-scrollbars', '--force-device-scale-factor=2', `--user-data-dir=${profileDir}`];

  let height = 1600;
  try {
    const { stdout } = await runBrowser(bin, [...base, '--dump-dom', url], { timeoutMs });
    const m = /id="__h"[^>]*>\s*(\d+)\s*</.exec(stdout);
    if (m) height = Math.max(400, Math.min(20000, Number(m[1])));
  } catch { /* 量高度失败就退回默认值 */ }

  await runBrowser(bin, [...base, `--screenshot=${pngFile}`, `--window-size=${width},${height}`, url], { timeoutMs });
  for (let i = 0; i < 20; i += 1) {
    if (fs.existsSync(pngFile) && fs.statSync(pngFile).size > 1000) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const buf = fs.readFileSync(pngFile);
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败无妨 */ }
  if (!buf.length) throw new Error('截图结果为空');
  return buf;
}

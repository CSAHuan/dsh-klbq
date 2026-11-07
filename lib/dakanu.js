// dakanu.com 数据访问层。
//
// 两个必须保留的细节（都是实测结论，改动前先读）：
//
// 1) **SNI 阻断**：本机直连 https://dakanu.com 会在 TLS 握手阶段被 RST
//    （ClientHello 里带这个域名就被重置；不带 SNI 直连 IP 能正常拿到 301/200）。
//    因此统一「连 IP + servername:'' 不发 SNI + Host 头指明站点」，
//    并设置 rejectUnauthorized:false —— 证书是签给域名的，省略 SNI 后必然对不上。
//    这条通道只取公开战绩、不传任何凭据；不要用它传输密钥或隐私数据。
//    注意：servername 必须是**空字符串**，写 undefined 时 Node 会补成域名 → 必被重置。
//
// 2) **两套段位体系**：排位是「原子/质子/中子/电子/夸克/超弦…」（按 segment 号段），
//    挑战赛是「青铜…传奇」（按 gradeScore 算）。卡片右上角用排位，别混用。

import https from 'node:https';
import dns from 'node:dns';

const SITE_HOST = 'www.dakanu.com';
// 2026-11 实测的 A 记录；解析失败时兜底
const FALLBACK_IPS = ['43.169.14.133', '43.169.13.133'];
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

let ipCache = { at: 0, ips: [] };

/** 解析站点 IP：系统 DNS 没被拦（只有 SNI 被拦），失败退回内置列表 */
async function resolveSiteIps() {
  const now = Date.now();
  if (ipCache.ips.length && now - ipCache.at < 10 * 60 * 1000) return ipCache.ips;
  try {
    const list = await dns.promises.resolve4(SITE_HOST);
    if (list.length) {
      ipCache = { at: now, ips: list };
      return list;
    }
  } catch { /* 用兜底 IP */ }
  return FALLBACK_IPS;
}

function httpsGetOnce(ip, pathname, { timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: ip,
      port: 443,
      path: pathname,
      method: 'GET',
      servername: '',            // 关键：空字符串，不能是 undefined
      rejectUnauthorized: false,  // 证书签给域名；这条通道只取公开数据
      headers: {
        host: SITE_HOST,
        'user-agent': UA,
        accept: 'application/json, text/plain, */*',
        'accept-language': 'zh-CN,zh;q=0.9',
        'accept-encoding': 'identity',
      },
      timeout: timeoutMs,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, text: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => req.destroy(new Error(`请求超时（${ip}${pathname}）`)));
    req.on('error', reject);
    req.end();
  });
}

/** 依次尝试各 IP，返回第一个非 5xx 响应 */
export async function dakanuGet(pathname, opts = {}) {
  let lastError = null;
  for (const ip of await resolveSiteIps()) {
    try {
      const res = await httpsGetOnce(ip, pathname, opts);
      if (res.status >= 500) { lastError = new Error(`HTTP ${res.status}`); continue; }
      return res;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError ?? new Error('dakanu 请求失败');
}

async function dakanuJson(pathname) {
  const res = await dakanuGet(pathname);
  let json = null;
  try { json = JSON.parse(res.text); } catch { /* 下面统一报错 */ }
  if (!json) throw new Error(`返回非 JSON（HTTP ${res.status}）`);
  return json;
}

/** 按昵称搜索玩家 */
export async function searchPlayers(query) {
  const q = String(query ?? '').trim();
  if (!q) throw new Error('昵称不能为空');
  const json = await dakanuJson(`/api/search/players?q=${encodeURIComponent(q)}`);
  const list = Array.isArray(json?.suggestions) ? json.suggestions : [];
  return list
    .map((s) => ({
      playerId: String(s.playerId ?? ''),
      nickname: String(s.nickname ?? ''),
      exact: s.exact === true,
      level: s.level ?? null,
    }))
    .filter((s) => s.playerId && s.nickname);
}

/** 拉取玩家详情（段位/总览/模式/角色/最近对局） */
export async function fetchSummoner(playerId, nickname) {
  const qs = nickname ? `?nickname=${encodeURIComponent(nickname)}` : '';
  const json = await dakanuJson(`/api/summoner/${encodeURIComponent(playerId)}${qs}`);
  if (!json?.ok || !json.profile) throw new Error(json?.error || '查询失败：站点未返回战绩数据');
  return json.profile;
}

/** 排位段位表（站点前端 es[]）：按 segment 号段映射，段内分 IV~I */
export const RANKED_TIERS = [
  { id: 'substance', name: '至纯物质', fromSeg: 1, toSeg: 3, divisions: ['III', 'II', 'I'], color: '#6c7178' },
  { id: 'molecule', name: '升格分子', fromSeg: 4, toSeg: 6, divisions: ['III', 'II', 'I'], color: '#c07a52' },
  { id: 'atom', name: '虚空原子', fromSeg: 7, toSeg: 10, divisions: ['IV', 'III', 'II', 'I'], color: '#9aa7b5' },
  { id: 'proton', name: '聚变质子', fromSeg: 11, toSeg: 14, divisions: ['IV', 'III', 'II', 'I'], color: '#d0a63c' },
  { id: 'neutron', name: '自由中子', fromSeg: 15, toSeg: 18, divisions: ['IV', 'III', 'II', 'I'], color: '#28b3a4' },
  { id: 'electron', name: '束缚电子', fromSeg: 19, toSeg: 23, divisions: ['V', 'IV', 'III', 'II', 'I'], color: '#3f8fd6' },
  { id: 'quark', name: '禁闭夸克', fromSeg: 24, toSeg: 28, divisions: ['V', 'IV', 'III', 'II', 'I'], color: '#9b5cd6' },
  { id: 'superstring', name: '无限超弦', fromSeg: 29, toSeg: 29, divisions: [], color: '#d94a44' },
  { id: 'singularity', name: '奇点', fromSeg: 30, toSeg: 30, divisions: [], color: '#d84a4a' },
];

export function rankedTierOf(segment) {
  const seg = Number(segment);
  if (!Number.isFinite(seg) || seg < 1) return null;
  const tier = RANKED_TIERS.find((t) => seg >= t.fromSeg && seg <= t.toSeg);
  if (!tier) return null;
  return { name: tier.name, division: tier.divisions[seg - tier.fromSeg] ?? '', color: tier.color, segment: seg };
}

export function rankedLabel(segment) {
  const t = rankedTierOf(segment);
  if (!t) return '未定级';
  return t.division ? `${t.name} ${t.division}` : t.name;
}

// dsh-klbq — 卡拉彼丘战绩查询插件。
//
// 只做一件事：把一个 `klbq_query` 工具挂进 DSH，让 agent（以及通过桥接接进来的 QQ）
// 能按昵称查战绩，并把结果渲染成一张长图落到本地文件。
//
// 设计取舍：
//   - 不返回 base64 图片。工具结果是进模型上下文的，一张 500KB 的 PNG 变成 base64 会把
//     上下文撑爆；改成「写文件 + 返回路径 + 关键数据摘要」，模型看摘要、人看图片。
//   - 不依赖 canvas/puppeteer：用系统自带 Edge 无头截图（见 render.js 的说明）。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { searchPlayers, fetchSummoner, rankedLabel, rankedTierOf } from './dakanu.js';
import { buildHtml, renderPng } from './render.js';
import { detectQQBot, installQQBotBridge } from './qqbot.js';

export const name = 'dsh-klbq';
export const inject = ['tools'];

const DEFAULT_MAX_MATCHES = 10;

/** 图片输出目录：系统临时目录下，避免污染用户工作区 */
function cardDir() {
  const dir = path.join(os.tmpdir(), 'dsh-klbq-cards');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

const pct = (v) => `${((Number(v) || 0) * 100).toFixed(1)}%`;
const num = (v, d = 0) => (Number.isFinite(Number(v)) ? (d ? Number(v).toFixed(d) : String(Math.round(Number(v)))) : '-');

function summaryText(value) {
  if (!value?.ok) return `查询失败：${value?.error ?? '未知错误'}`;
  const s = value.summary ?? {};
  const lines = [
    `${value.nickname}（Lv.${value.level ?? '-'}）`,
    `当前段位：${value.currentRank}　历史最高：${value.topRank}`,
    `场次 ${num(s.rounds)}　胜率 ${pct(s.winRate)}　KDA ${num(s.kda, 2)}　均伤 ${num(s.avgDamage)}`,
    `图片：${value.imagePath}`,
  ];
  if (value.recent?.length) {
    lines.push(`最近 ${value.recent.length} 场：` + value.recent.map((m) => `${m.result === 'win' ? '胜' : '负'} ${m.kda}`).join(' / '));
  }
  return lines.join('\n');
}

/**
 * 昵称 → 图片。抽成独立函数，方便测试/复用。
 * @param {string} nickname
 * @param {{maxMatches?: number, browserPath?: string, width?: number}} options
 */
export async function queryPlayer(nickname, options = {}) {
  const q = String(nickname ?? '').trim();
  if (!q) throw new Error('nickname 不能为空');

  const candidates = await searchPlayers(q);
  if (!candidates.length) throw new Error(`没找到玩家「${q}」，检查游戏昵称是否正确`);

  // 精确匹配 > 前缀匹配 > 第一个候选
  const lower = q.toLowerCase();
  const pick = candidates.find((c) => c.nickname.toLowerCase() === lower)
    ?? candidates.find((c) => c.nickname.toLowerCase().startsWith(lower))
    ?? candidates[0];

  const profile = await fetchSummoner(pick.playerId, pick.nickname);
  const maxMatches = Math.max(0, Math.min(20, Number(options.maxMatches ?? DEFAULT_MAX_MATCHES) || DEFAULT_MAX_MATCHES));
  const width = Number(options.width ?? 900) || 900;

  const html = buildHtml(profile, { width, maxMatches });
  const buffer = await renderPng(html, { width, browserPath: options.browserPath });

  const safeName = String(profile.player?.nickname ?? pick.nickname).replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40);
  const file = path.join(cardDir(), `${safeName}-${Date.now()}.png`);
  fs.writeFileSync(file, buffer);

  const s = profile.summary ?? {};
  const matches = Array.isArray(profile.matches) ? profile.matches.slice(0, maxMatches) : [];
  return {
    ok: true,
    nickname: profile.player?.nickname ?? pick.nickname,
    playerId: pick.playerId,
    level: profile.player?.level ?? null,
    currentRank: rankedLabel(profile.rank?.segment),
    topRank: rankedLabel(profile.rank?.historicalSegment),
    currentSegment: profile.rank?.segment ?? null,
    topSegment: profile.rank?.historicalSegment ?? null,
    summary: {
      rounds: s.rounds ?? null,
      wins: s.wins ?? null,
      losses: s.losses ?? null,
      winRate: s.winRate ?? null,
      kda: s.kda ?? null,
      kd: s.kd ?? null,
      avgDamage: s.avgDamage ?? null,
      avgKill: s.avgKill ?? null,
      mvpRate: s.mvpRate ?? null,
      headshotRate: s.headshotRate ?? null,
    },
    matches: matches.length,
    recent: matches.map((m) => ({
      result: m.result,
      mode: m.modeLabel ?? m.mode ?? null,
      kda: `${num(m.kills)}/${num(m.deaths)}/${num(m.assists)}`,
      score: `${num(m.myScore)}:${num(m.opponentScore)}`,
    })),
    imagePath: file,
    imageBytes: buffer.length,
  };
}

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    error: { type: 'string' },
    nickname: { type: 'string' },
    playerId: { type: 'string' },
    level: { type: 'number' },
    currentRank: { type: 'string' },
    topRank: { type: 'string' },
    imagePath: { type: 'string' },
    imageBytes: { type: 'number' },
  },
};

const DEFINITION = {
  name: 'klbq_query',
  description:
    '查询卡拉彼丘（Strinova）玩家战绩。按游戏昵称在 dakanu.com 取数，'
    + '渲染一张包含排位段位（当前/历史最高）、总览、模式、角色、最近对局的长图，'
    + '图片写到本地并返回路径与关键数据摘要。'
    + '在 QQ 机器人等即时通讯通道里，拿到 imagePath 后应调用 present 把它声明为交付物，'
    + '图片会随本轮自动发送给用户。',
  parameters: {
    type: 'object',
    properties: {
      nickname: { type: 'string', description: '游戏昵称或 UID，例如 ahiahdiawh' },
      maxMatches: { type: 'number', description: `最近对局条数，0~20，默认 ${DEFAULT_MAX_MATCHES}` },
    },
    required: ['nickname'],
    additionalProperties: false,
  },
  output: {
    schema: OUTPUT_SCHEMA,
    render: (_args, value) => [{ type: 'text', text: summaryText(value) }],
  },
  async resolve(args) {
    try {
      return await queryPlayer(args?.nickname, { maxMatches: args?.maxMatches });
    } catch (error) {
      return { ok: false, error: String(error?.message ?? error) };
    }
  },
};

export function apply(ctx, config = {}) {
  // 加载自检：插件装好了但没被 loader 挂上时，光看「没报错」分辨不出来。
  // 每次 apply 往临时目录追加一行，够判断 DSH 到底有没有把它载入。
  const marker = path.join(os.tmpdir(), 'dsh-klbq-plugin.log');
  const note = (msg) => {
    try { fs.appendFileSync(marker, `[${new Date().toISOString()}] ${msg}\n`); } catch { /* 自检写不进去不影响主流程 */ }
  };
  note('apply() 已执行');

  try {
    const dispose = ctx.tools.register(DEFINITION);
    note('klbq_query 注册成功');
    ctx.effect(() => () => {
      try { dispose?.(); } catch { /* 卸载失败不该拖垮进程退出 */ }
    }, 'dsh-klbq: klbq_query tool');
  } catch (error) {
    // 不抛出：插件挂不上也不该让 DSH 启动失败，但必须留下原因。
    note(`klbq_query 注册失败：${error?.message ?? error}`);
    ctx.logger?.warn?.(`dsh-klbq: klbq_query 注册失败：${error?.message ?? error}`);
  }

  // ── QQ 官方机器人通道适配 ──
  // dsh-qqbot 的 /klbq 不会命中它自己的命令表，最终作为普通消息进 agent，
  // 所以这里把「收到 /klbq 该怎么做」挂到 system prompt 上。
  try {
    const qqbotConfig = config?.integrations?.qqbot ?? {};
    if (qqbotConfig.promptInjection === false) {
      note('QQ 机器人适配：已按配置禁用');
    } else if (detectQQBot()) {
      const ok = installQQBotBridge(ctx, { logger: ctx.logger, prompt: qqbotConfig.prompt });
      note(`QQ 机器人适配：${ok ? '已挂载' : '挂载失败'}`);
    } else {
      note('QQ 机器人适配：未检测到 @tencent-connect/dsh-qqbot，跳过');
    }
  } catch (error) {
    note(`QQ 机器人适配异常：${error?.message ?? error}`);
    ctx.logger?.warn?.(`dsh-klbq: QQ 机器人适配异常：${error?.message ?? error}`);
  }
}

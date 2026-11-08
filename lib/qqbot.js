// 与 @tencent-connect/dsh-qqbot（QQ 官方机器人通道）的适配层。
//
// 为什么是「提示词注入」而不是注册斜杠命令：
//   dsh-qqbot 的命令表是硬编码的（dist/commands/index.js 的 buildCommandList），
//   没有对外扩展点，第三方插件加不进 /klbq。但它的 slashCommand 中间件对
//   **未注册**的命令是 `await next()` 放行的（qqbot-nodejs/dist/middleware/
//   slash-command.js 第 124-128 行），所以 `/klbq 昵称` 不会被吞掉，会照常
//   进入 agent 回合。于是我们要做的只是教会 agent 收到这类消息该干什么。
//
// 代价：注入的段落会出现在每个回合的 system prompt 里（约 150 token）。
// 不需要的话可以在插件配置里关掉：integrations.qqbot.promptInjection = false。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const QQ_BOT_PACKAGE = '@tencent-connect/dsh-qqbot';
const SECTION_NAME = 'dsh-klbq:qqbot-usage';
const PKG_ENTRY = QQ_BOT_PACKAGE + '/package.json';

const HERE = path.dirname(fileURLToPath(import.meta.url));

let detected; // undefined = 未探测过

/**
 * 在 node_modules 里按目录结构逐级向上找这个包。
 *
 * 插件常常以 `link:` 方式挂在 `~/.dsh/plugins/<name>`，而依赖装在
 * `~/.dsh/profiles/<profile>/node_modules`——不是它的祖先目录，
 * 单靠 require.resolve 会漏判。所以这里同时扫 profile 目录。
 */
function existsAsPackage(dir) {
  try {
    return fs.existsSync(path.join(dir, QQ_BOT_PACKAGE, 'package.json'));
  } catch {
    return false;
  }
}

function probeFileSystem() {
  // 1) 从插件自身目录逐级向上找 node_modules（npm 安装时的常规情况）
  let dir = HERE;
  for (let i = 0; i < 6; i += 1) {
    if (existsAsPackage(path.join(dir, 'node_modules'))) return true;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 2) 扫 DSH profile：要求「同一个 profile 里既有本插件、又有 qqbot」。
  //
  //    只判断有没有 qqbot 会误判——用户可能在别的 profile 装了它，而当前
  //    profile 根本没跑 QQ 通道，那样会白白往 system prompt 里塞 150 token。
  //    本插件以 link: 装时会出现在 profile 的 node_modules 里（软链），
  //    所以「同目录两者都在」是可靠的判据。
  try {
    const profilesDir = path.join(os.homedir(), '.dsh', 'profiles');
    for (const profile of fs.readdirSync(profilesDir).slice(0, 20)) {
      const modules = path.join(profilesDir, profile, 'node_modules');
      if (!existsAsPackage(modules)) continue;
      const hasSelf = fs.existsSync(path.join(modules, 'dsh-klbq'));
      if (hasSelf) return true;
    }
  } catch { /* 没有 .dsh 目录就用别的手段 */ }

  return false;
}

/** 判断 DSH 里有没有装 QQ 机器人通道（装了就认为需要适配）。结果会缓存。 */
export function detectQQBot() {
  if (detected !== undefined) return detected;

  const require = createRequire(import.meta.url);
  for (const spec of [PKG_ENTRY, QQ_BOT_PACKAGE]) {
    try {
      require.resolve(spec);
      detected = true;
      return detected;
    } catch { /* 继续试下一种手段 */ }
  }

  detected = probeFileSystem();
  return detected;
}

/** 测试用：清掉探测缓存 */
export function resetQQBotDetection() {
  detected = undefined;
}

/** 注入给 agent 的使用说明（保持简短，它每轮都在上下文里） */
export const QQBOT_PROMPT = [
  '## 卡拉彼丘战绩查询（dsh-klbq）',
  '',
  '当用户消息以 `/klbq` 或 `klbq` 开头，或直接要求查卡拉彼丘（Strinova）战绩时：',
  '1. 昵称 = 命令后面的**全部**文字，可能含空格，不要去头去尾随意截断。',
  '2. 调用 `klbq_query` 工具（参数 `nickname`，可选 `maxMatches` 0~20）。',
  '3. 工具返回 `imagePath`（本地 PNG 绝对路径）。若当前通道支持发文件，',
  '   紧接着调用 `present` 把该路径声明为交付物，图片会自动发到聊天里；',
  '   同时用一两句话点出段位、场次、胜率这几个关键数字，不要复述整张图。',
  '4. 返回 `ok:false` 时把 `error` 原样告诉用户，**不要**编造数据。',
].join('\n');

/** 判断 DSH 里有没有装 QQ 机器人通道（装了就认为需要适配） */

/**
 * 把 /klbq 的使用说明挂到 system prompt 上。
 *
 * 契约与 dsh-qqbot 自身一致（dist/session/session-manager.js 的
 * registerScopePromptInjection）：`(assembly, context, next)` 瀑布流，
 * 先 await next() 拿到下游组装结果，再追加 section。
 *
 * @param {any} ctx cordis 上下文
 * @param {{logger?: any, prompt?: string, enabled?: boolean}} [options]
 * @returns {boolean} 是否成功挂载
 */
export function installQQBotBridge(ctx, options = {}) {
  if (typeof ctx?.on !== 'function') return false;

  const text = options.prompt ?? QQBOT_PROMPT;
  const logger = options.logger;

  const handler = async (assembly, context, next) => {
    const assembled = await next();
    // 只在有 agent 的回合注入；非 agent 的组装（如摘要压缩）不动。
    if (!context?.agent) return assembled;
    const sections = Array.isArray(assembled?.sections) ? assembled.sections : [];
    // 幂等：同一个组装里已经有我们的段落就不再叠加。
    if (sections.some((s) => s?.name === SECTION_NAME)) return assembled;
    return { ...assembled, sections: [...sections, { name: SECTION_NAME, order: 95, text }] };
  };

  try {
    const dispose = ctx.on('system-prompt/assemble', handler);
    logger?.info?.('dsh-klbq: 已注入 QQ 机器人（/klbq）使用说明');
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => () => {
        try { dispose?.(); } catch { /* 卸载失败不影响进程 */ }
      }, 'dsh-klbq: qqbot system-prompt hook');
    }
    return true;
  } catch (error) {
    logger?.warn?.(`dsh-klbq: QQ 机器人适配挂载失败：${error?.message ?? error}`);
    return false;
  }
}

export { SECTION_NAME };
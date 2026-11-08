# dsh-klbq

卡拉彼丘（Strinova）战绩查询的 DSH 插件：按游戏昵称从 [dakanu.com](https://dakanu.com) 取数，
渲染成一张长图（排位段位 / 总览 / 模式 / 角色 / 最近对局），并把工具 `klbq_query` 暴露给 agent。

## 提供的工具

### `klbq_query`

| 参数 | 类型 | 说明 |
|---|---|---|
| `nickname` | string（必填） | 游戏昵称或 UID |
| `maxMatches` | number | 最近对局条数 0~20，默认 10 |

返回：

```jsonc
{
  "ok": true,
  "nickname": "ahiahdiawh",
  "level": 62,
  "currentRank": "束缚电子 II",      // 排位当前段位
  "topRank": "禁闭夸克 III",         // 排位历史最高
  "summary": { "rounds": 30, "winRate": 0.5, "kda": 2.86, "avgDamage": 3220, ... },
  "recent": [ { "result": "win", "mode": "排位爆破", "kda": "8/6/15", "score": "9:4" } ],
  "imagePath": "C:\\Users\\...\\Temp\\dsh-klbq-cards\\ahiahdiawh-1794051495410.png",
  "imageBytes": 413696
}
```

图片写到系统临时目录的 `dsh-klbq-cards/` 下。**工具不返回 base64**——
一张 500KB 的 PNG 进上下文会非常浪费，所以「模型看摘要、人看图片」。

## 安装

插件以本地 link 方式挂在 DSH profile 上：

```json
// ~/.dsh/profiles/<profile>/package.json
"dependencies": { "dsh-klbq": "link:C:/Users/<you>/.dsh/plugins/dsh-klbq" },
"dsh": { "profile": { "bundles": [ ..., "dsh-klbq" ] } }
```

并把插件目录软链到 profile 的 `node_modules/dsh-klbq`。DSH 重启后生效。

## 两个实现要点（改代码前务必先读）

1. **SNI 阻断**：本机直连 `https://dakanu.com` 会在 TLS 握手阶段被 RST
   （ClientHello 带这个域名就被重置；不带 SNI 直连 IP 能拿到 301/200）。
   因此请求统一「连 IP + `servername: ''` + `Host` 头」，并 `rejectUnauthorized: false`。
   `servername` 必须是**空字符串**，写成 `undefined` 时 Node 会补成域名 → 必被重置。
   这条通道只取公开战绩、不传凭据；**不要**用它传输密钥或隐私数据。

2. **两套段位体系**：排位是「至纯物质 / 升格分子 / 虚空原子 / 聚变质子 / 自由中子 /
   束缚电子 / 禁闭夸克 / 无限超弦 / 奇点」（按 `rank.segment` 号段）；
   挑战赛是「青铜…传奇」（按 `gradeScore` 算）。卡片右上角用排位，别混用。

## 渲染

用系统自带的 Edge / Chrome 无头截图（两趟：先 `--dump-dom` 量内容高度，再按高度截图），
不引入 canvas / puppeteer 之类的重依赖。找不到浏览器时可用环境变量 `KLBQ_BROWSER` 指定路径。

## 与 QQ 官方机器人（`@tencent-connect/dsh-qqbot`）配合使用

装了这个通道之后，在 QQ 私聊或群里直接发：

```
/klbq 才知道左键能开枪
```

图片会作为本轮交付物自动发回聊天。

**实现方式**（不是注册斜杠命令）：

`dsh-qqbot` 的命令表是硬编码的（`dist/commands/index.js` 的 `buildCommandList`），
没有对外扩展点，第三方插件加不进 `/klbq`。但它用的 `slashCommand` 中间件对
**未注册**的命令是 `await next()` 放行的（`qqbot-nodejs/dist/middleware/slash-command.js`），
所以 `/klbq xxx` 不会被吞掉，会当作普通消息进入 agent 回合。

于是本插件挂到 `system-prompt/assemble` 瀑布流上，注入一小段说明，告诉 agent：
收到 `/klbq` 就调用 `klbq_query`，拿到 `imagePath` 后再用 `present` 声明为交付物
（`dsh-qqbot` 的 `DeliverablesDeliverer` 会在轮末把文件发出去）。

**配置**

```jsonc
// cordis 配置片段
{
  "integrations": {
    "qqbot": {
      "promptInjection": true,   // 默认 true；关掉就不再注入说明
      "prompt": "……"             // 可选，完全替换默认那段说明
    }
  }
}
```

> 注入的说明每轮都在 system prompt 里（约 150 token）。没装 `dsh-qqbot` 时
> 插件会自动跳过，不产生任何开销。

## 更新日志

### 0.2.0 — 适配 QQ 官方机器人

- 新增 `lib/qqbot.js`：检测 `@tencent-connect/dsh-qqbot` 是否存在，存在则向
  `system-prompt/assemble` 注入 `/klbq` 用法，让 QQ 里发指令可直接出图
- 检测兼容 `link:` 安装（插件在 `~/.dsh/plugins`，依赖在 `~/.dsh/profiles/*/node_modules`，
  不是祖先目录，`require.resolve` 会漏判，所以同时扫 profile 目录）
- 工具描述补充「IM 通道拿到 imagePath 后应调用 present 交付」

### 0.1.1 — 取数提速

dakanu 站点有两个 A 记录，快慢差 **5 倍**（实测搜索接口 5.37s vs 0.93s）。
旧版按 DNS 顺序依次尝试，会稳定命中慢的那个，用户感知就是「查一次要八九秒」。

- **双 IP 并行对冲**：两个 IP 同时发请求，谁先成功用谁，耗时取决于较快者
- **连接复用**：一次查询的「搜索 + 详情」共用同一条 TLS 连接，省掉第二次握手
- **结果缓存**：搜索映射缓存 10 分钟、详情缓存 90 秒，重复查询不再走网络

实测：搜索 3565ms → ~700ms，详情 5555ms → ~1000ms，重复查询整链 ~2s（原 ~9s）。

## 许可

MIT
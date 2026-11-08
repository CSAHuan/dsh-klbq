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

## 更新日志

### 0.1.1 — 取数提速

dakanu 站点有两个 A 记录，快慢差 **5 倍**（实测搜索接口 5.37s vs 0.93s）。
旧版按 DNS 顺序依次尝试，会稳定命中慢的那个，用户感知就是「查一次要八九秒」。

- **双 IP 并行对冲**：两个 IP 同时发请求，谁先成功用谁，耗时取决于较快者
- **连接复用**：一次查询的「搜索 + 详情」共用同一条 TLS 连接，省掉第二次握手
- **结果缓存**：搜索映射缓存 10 分钟、详情缓存 90 秒，重复查询不再走网络

实测：搜索 3565ms → ~700ms，详情 5555ms → ~1000ms，重复查询整链 ~2s（原 ~9s）。

## 许可

MIT
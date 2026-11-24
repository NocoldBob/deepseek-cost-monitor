<p align="center">
  <img src="resources/icon-options/whale-chart.png" width="128" height="128" alt="一只正在看柱状图的蓝色鲸鱼">
</p>

<h1 align="center">DeepSeek Cost Monitor</h1>

<p align="center"><strong>一只住在 VS Code 侧边栏里的鲸鱼记账员 🐋</strong></p>

<p align="center"><em>不碰 API Key，不发网络请求，只在本地日志里捞 token，按官方价目表算今天的账。</em></p>

<p align="center"><sub>v0.1.1 · 本地优先 · 零依赖 · 不需要 API Key</sub></p>

---

## 为什么要养这只鲸鱼？

用 Claude Code 写代码、把后端接到 DeepSeek，体验很顺；但一天下来到底烧了多少 token、折合多少钱，往往要开控制台、翻账单、再拿计算器按半天。

DeepSeek 目前没有公开的逐请求用量 API。与其盯着余额猜今天花了多少，不如直接读 Claude Code 已经写在本地的会话记录。

于是这只鲸鱼来了：它不问你钥匙，也不替你发请求，只是把本地 JSONL 里的 `usage` 数字捞出来，数一数输入、缓存命中和输出 token，再按 DeepSeek 官方价目表拨拨算盘，最后在侧边栏里给你一个**今日消费估算**。

一句话：**它不生产账单，它只是账单的搬运工（估算版）。**

## 它怎么算账？🧮

- **只看本地记录**：读取 `~/.claude/projects/**/*.jsonl` 中每条 assistant 响应的 `usage`，不向任何服务器核对。
- **token 三件套**：缓存未命中输入、缓存命中输入、输出；当前端点的缓存写入费按 0 计。
- **流式去重**：同一个 `message.id` 可能有多行快照，只算一次，保留输出 token 最大的完整快照。
- **按钟点计价**：以北京时间（UTC+8）划分“今天”；工作日 `09:00–12:00`、`14:00–18:00` 为高峰，其余时间及法定节假日按低谷计价（半价）。
- **按官方价目**：支持 CNY / USD 两套官方价目，不做汇率换算；模型名后的 `[1m]` 等别名会先去掉再查价。
- **子代理也算**：默认把子代理请求并入父会话；可以在设置里关掉。

> 当前价目（CNY，高峰价，每百万 token，开发时 2026-11 的官方公开价）：
>
> | 模型 | 缓存命中 | 缓存未命中 | 输出 |
> |---|---:|---:|---:|
> | `deepseek-flash` | ¥0.04 | ¥2.00 | ¥8.00 |
> | `deepseek-v4-pro` | ¥0.30 | ¥9.00 | ¥27.00 |
>
> 低谷价为高峰价的一半；无长上下文加价。价格调整时可自行覆盖 `rateOverrides`。

## 它绝对不碰 🔒

- 不需要 DeepSeek API Key，也不需要任何登录或认证凭据。
- 不向 DeepSeek 发请求，不拦截、不代理、不重放你的流量。
- 没有遥测、没有上报、没有把会话记录打包寄出去。
- 不在本地另存一份账本；聚合结果只留在扩展内存里。

你的 token 和聊天记录都待在这台机器上。鲸鱼只负责看，不负责外传。

## 你会看到什么？

- 侧边栏“今日消费”：今日金额、去重请求数、token 明细、高峰/低谷徽标。
- 按模型的金额与 token 拆分。
- 按会话的金额、cwd、session 短 ID 拆分。
- 状态栏实时金额；点击聚焦侧边栏。
- 文件变化自动刷新，另有 10–3600 秒可调的定时刷新。
- 估算警告：未知 DeepSeek 模型、被排除的非 DeepSeek 模型等。

## 安装

**当前版本 0.1.1，Marketplace 发布准备已完成。** 发布后可直接在扩展视图搜索 **DeepSeek Cost Monitor**，或执行：

```bash
code --install-extension NocoldBob.deepseek-cost-monitor
```

Marketplace 页面（发布后）：<https://marketplace.visualstudio.com/items?itemName=NocoldBob.deepseek-cost-monitor>

在 Marketplace 上架前，也可以从 VSIX 安装。

### Windows PowerShell

```powershell
git clone https://github.com/NocoldBob/deepseek-cost-monitor.git
cd deepseek-cost-monitor
npm install
npm run package
code --install-extension .\deepseek-cost-monitor-0.1.1.vsix
```

Windows 用户也可以直接运行 `.\pack.ps1` 打包、`.\install.ps1` 安装最新 VSIX。

### Linux / macOS

```bash
git clone https://github.com/NocoldBob/deepseek-cost-monitor.git
cd deepseek-cost-monitor
npm install
npm run package
code --install-extension ./deepseek-cost-monitor-0.1.1.vsix
```

如果已经拿到现成的 VSIX，只需执行最后一行安装命令，不需要 Node.js。

安装后执行 VS Code 命令 **Developer: Reload Window**，点击活动栏的 **DeepSeek 消费** 图标即可。

扩展运行时不依赖 npm 包，没有构建步骤，也没有原生依赖——这只鲸鱼吃的是纯 JavaScript。只有制作 VSIX 时需要 Node.js 22+ 来安装 `vsce` 开发依赖。

开发调试：用 VS Code 打开仓库，按 `F5` 启动扩展开发宿主。

## 平台支持

- Windows 10/11、Ubuntu 22.04/24.04、macOS 等 VS Code 桌面平台。
- 纯 JavaScript，无原生依赖；同一个 VSIX 跨平台通用。
- 要求 VS Code 1.90.0 及以上。
- 扩展在本机运行，读取本机会话记录；Remote-SSH 远端机器上的日志不在当前版本的统计范围内。

## 常用命令

| 命令 | 作用 |
|---|---|
| `DeepSeek: 刷新 DeepSeek 消费` | 立即重新扫描本机会话记录 |
| `DeepSeek: 打开 DeepSeek 消费面板` | 聚焦侧边栏 |
| `DeepSeek: 输出诊断与自检信息` | 在输出面板打印设置、计价断言和统计快照 |

## 设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `deepseekCostMonitor.projectsPath` | 空 | 留空使用 `~/.claude/projects` |
| `deepseekCostMonitor.modelPrefixes` | `["deepseek"]` | 计入统计的模型前缀 |
| `deepseekCostMonitor.currency` | `CNY` | `CNY` 或 `USD` |
| `deepseekCostMonitor.includeSubagents` | `true` | 是否统计子代理 |
| `deepseekCostMonitor.showStatusBar` | `true` | 是否显示状态栏金额 |
| `deepseekCostMonitor.refreshIntervalSeconds` | `30` | 定时刷新间隔（10–3600） |
| `deepseekCostMonitor.rateOverrides` | `{}` | 按模型覆盖高峰单价 |
| `deepseekCostMonitor.holidays` | 内置 2026 | 法定节假日（北京时间） |

## 口径与边界

- 统计的是**本机所有 Claude Code 会话**，不只当前工作区；想只看某个目录，可以改 `projectsPath`。
- “今日”按北京时间切；请求数按 `message.id` 去重；总 token 含缓存命中，因此可能和 DeepSeek 控制台的 “Tokens” 口径不同。
- 金额是**估算**，不是官方账单：流式中间态、失败请求、价目调整、节假日表过期都可能造成偏差。报销、对账、发票请以 DeepSeek 控制台为准。
- 只读取追加式 JSONL；同一个文件被原地重写成相同或更小尺寸的情况检测不到。
- 内置节假日表需要每年更新；2027 年起请更新 `holidays`。
- 这是社区项目，不是 DeepSeek 官方产品，与 DeepSeek 无隶属关系。

## 适合谁？

适合：用 Claude Code + DeepSeek，想知道“今天大概花了多少”，又不想交出 API Key 的开发者。

不太适合：需要官方账单、团队分账或精确发票的财务场景，以及不用 Claude Code 或主要使用其他模型的场景。

## 反馈

发现数字不对劲，或者鲸鱼又算错了一笔？欢迎提 Issue。贴出诊断信息前，请先删掉本机路径、会话 ID 等隐私内容。

---

如果这只鲸鱼帮你少开了一次控制台，欢迎给它一颗 ⭐。

它不会说话，但会在状态栏里默默把今天的数字更新下去。

## License

除鲸鱼封面图外，本仓库的全部内容采用 [MIT License](LICENSE)。

鲸鱼封面图 `resources/icon-options/whale-chart.png` 除外，不包含在 MIT 授权范围内；版权归作者所有，具体见 [ASSET-LICENSE.md](ASSET-LICENSE.md)。

# DeepSeek Cost Monitor

在 VS Code 侧边栏查看**今日 DeepSeek API 估算消费**。扩展读取本机 Claude Code 会话记录中的 token 用量，按 DeepSeek 官方价目表估算金额。

## 功能

- 今日消费金额、请求数与 token 明细（未命中输入 / 命中缓存 / 输出）
- 按模型、按会话拆分
- 状态栏实时金额，点击打开侧边栏
- 高峰 / 低谷与法定节假日自动计价
- 支持 CNY / USD 两套官方价目
- 会话文件变化自动刷新，也可定时刷新

## 使用

1. 安装后点击活动栏的 **DeepSeek 消费** 图标。
2. 默认读取 `~/.claude/projects/**/*.jsonl`；如果记录在其他目录，设置 `deepseekCostMonitor.projectsPath`。
3. 状态栏会显示今日金额，点击可打开面板。
4. 需要手动刷新时，执行命令 **DeepSeek: 刷新 DeepSeek 消费**。

## 计价口径

- 默认只统计模型名以 `deepseek` 开头的请求，前缀可配置。
- 以北京时间划分“今天”；工作日 09:00–12:00、14:00–18:00 为高峰，其余时间及周末 / 法定节假日按低谷（半价）。
- 同一 `message.id` 的流式快照只计一次；子代理请求默认并入父会话。
- 未在价目表中的 DeepSeek 模型按 Flash 价估算，并在面板中提示。
- 金额是**估算**，不是官方账单；对账请以 DeepSeek 控制台为准。

## 主要设置

| 设置 | 默认 | 说明 |
|---|---|---|
| `deepseekCostMonitor.projectsPath` | 空 | 留空使用 `~/.claude/projects` |
| `deepseekCostMonitor.currency` | `CNY` | `CNY` 或 `USD` |
| `deepseekCostMonitor.includeSubagents` | `true` | 是否统计子代理 |
| `deepseekCostMonitor.showStatusBar` | `true` | 是否显示状态栏金额 |
| `deepseekCostMonitor.refreshIntervalSeconds` | `30` | 定时刷新间隔（10–3600 秒） |
| `deepseekCostMonitor.rateOverrides` | `{}` | 按模型覆盖高峰单价 |
| `deepseekCostMonitor.holidays` | 内置 2026 | 法定节假日，需每年更新 |

## 隐私

扩展只提取本地会话记录中的 token 用量、模型和时间等统计字段，不展示、不上传聊天内容；不需要 API Key，不发起网络请求，不收集遥测。

## 平台

Windows 10/11、Ubuntu 22.04/24.04、macOS，要求 VS Code 1.90 及以上。

## 说明

社区项目，与 DeepSeek 无隶属关系。除封面图外采用 [MIT License](LICENSE)，封面图许可见 [ASSET-LICENSE.md](ASSET-LICENSE.md)。

遇到数字异常时，可运行 **DeepSeek: 输出诊断与自检信息**，在输出面板查看扫描统计和计价自检结果。

# Changelog

本项目遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 格式，版本号遵循 [Semantic Versioning](https://semver.org/lang/zh-CN/)。

## [0.1.0] - 2026-11-24

### 新增

- 侧边栏“今日消费”面板：今日金额、请求数、token 明细、高峰/低谷徽标。
- 按模型、按会话的消费拆分。
- 状态栏实时金额，点击聚焦侧边栏。
- 基于 `~/.claude/projects/**/*.jsonl` 的本地增量扫描与流式去重。
- 文件变化自动刷新，以及 10–3600 秒可调的定时刷新。
- CNY / USD 双币种官方价目，支持按模型覆盖单价和自定义节假日。
- 未知模型、非 DeepSeek 请求排除等估算警告。
- 诊断命令，输出计价断言与扫描统计。

### 平台

- Windows 10/11、Ubuntu 22.04/24.04、macOS 等 VS Code 桌面平台。
- 纯 JavaScript，无原生依赖，单个 VSIX 跨平台通用。
- 要求 VS Code 1.90.0 及以上。

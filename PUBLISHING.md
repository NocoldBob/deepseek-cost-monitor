# 发布到 VS Code Marketplace

扩展 ID：`NocoldBob.deepseek-cost-monitor`

## 1. 准备发布者账号

1. 打开 <https://marketplace.visualstudio.com/manage>。
2. 创建 Publisher，ID 必须是 `NocoldBob`（与 `package.json` 的 `publisher` 完全一致）。
3. 首次发布前确认发布者资料已生效。

## 2. 本地打包（Windows / Linux / macOS 通用）

需要 Node.js 22 及以上版本（`@vscode/vsce` 4.x 的要求）。

```bash
npm install
npm run package
```

产物：`deepseek-cost-monitor-0.1.0.vsix`

安装验证：

```bash
code --install-extension ./deepseek-cost-monitor-0.1.0.vsix --force
```

Windows 下把 `./` 换成 `.\` 即可。VSIX 是纯 JavaScript 包，没有原生依赖，同一个文件可在 Windows 10/11、Ubuntu 22.04/24.04、macOS 上安装。

CI 构建：推送分支后，GitHub Actions 会在 Windows、Ubuntu 22.04、Ubuntu 24.04 三个环境分别打包，并上传 `vsix-windows`、`vsix-ubuntu-22.04`、`vsix-ubuntu-24.04` 三个 artifact。下载命令：

```bash
gh run list --workflow build-vsix.yml
gh run download <run-id> -D ci-artifacts
```

三个产物内容相同，任选其一即可发布。

## 3. 创建访问令牌

在 Azure DevOps 创建 Personal Access Token：

- Organization：选择包含 Marketplace 发布权限的组织（通常是个人默认组织）。
- Scope：`Marketplace` → `Manage`。

令牌属于敏感凭据，只在本机的受保护输入界面中使用：

- 不要粘贴到聊天、Issue、脚本、仓库文件或命令历史里。
- 推荐在本机终端执行 `npx vsce login NocoldBob`，按提示交互输入。
- 也可以在本机设置环境变量 `VSCE_PAT`，但不要写入仓库或共享目录。

## 4. 发布

```bash
npm run publish:marketplace
```

或发布指定版本：

```bash
npx vsce publish patch
npx vsce publish minor
```

发布后在 <https://marketplace.visualstudio.com/items?itemName=NocoldBob.deepseek-cost-monitor> 验证：

- README、图标、版本号、许可证是否正确。
- Windows 与 Linux 各安装一次，确认侧边栏和状态栏正常。

## 5. 版本与变更记录

- 修改 `package.json` 的 `version`，或使用 `vsce publish patch|minor|major` 自动递增。
- 在 `CHANGELOG.md` 补充对应版本条目。
- 发布前跑一遍 `npm run check`（需要本机存在 `~/.claude/projects` 会话记录）。

'use strict';

const vscode = require('vscode');

exports.run = async function () {
  const extension = vscode.extensions.getExtension('local.deepseek-cost-monitor');
  if (!extension) throw new Error('未找到扩展 local.deepseek-cost-monitor');
  await extension.activate();

  const allCommands = await vscode.commands.getCommands(true);
  for (const id of ['deepseekCostMonitor.refresh', 'deepseekCostMonitor.focus', 'deepseekCostMonitor.showDiagnostics']) {
    if (!allCommands.includes(id)) throw new Error(`缺少命令：${id}`);
  }

  await vscode.commands.executeCommand('deepseekCostMonitor.refresh');
  await vscode.commands.executeCommand('deepseekCostMonitor.showDiagnostics');
  await vscode.commands.executeCommand('deepseekCostMonitor.focus');

  const config = vscode.workspace.getConfiguration('deepseekCostMonitor');
  if (config.get('currency', 'CNY') !== 'CNY') throw new Error('默认币种配置异常');
  if (config.get('refreshIntervalSeconds', 30) !== 30) throw new Error('默认刷新间隔配置异常');

  console.log('REAL_CHECK_PASS');
};

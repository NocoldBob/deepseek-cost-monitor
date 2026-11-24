'use strict';

const vscode = require('vscode');
const { UsageMonitor } = require('./src/monitor');
const { MonitorPanelProvider } = require('./src/panel');
const { StatusBar } = require('./src/statusBar');

async function focusView() {
  try {
    await vscode.commands.executeCommand('deepseekCostMonitor.today.focus');
  } catch {
    await vscode.commands.executeCommand('workbench.view.extension.deepseekCostMonitor');
  }
}

function activate(context) {
  const output = vscode.window.createOutputChannel('DeepSeek Cost Monitor');
  const monitor = new UsageMonitor(context, output);
  const panel = new MonitorPanelProvider(context.extensionUri, monitor);
  const statusBar = new StatusBar(monitor);

  context.subscriptions.push(
    output,
    monitor,
    panel,
    statusBar,
    vscode.window.registerWebviewViewProvider(
      'deepseekCostMonitor.today',
      panel,
      { webviewOptions: { retainContextWhenHidden: true } }
    ),
    vscode.commands.registerCommand('deepseekCostMonitor.refresh', () => monitor.refreshNow('manual')),
    vscode.commands.registerCommand('deepseekCostMonitor.focus', () => focusView()),
    vscode.commands.registerCommand('deepseekCostMonitor.showDiagnostics', async () => {
      await monitor.refreshNow('diagnostics');
      monitor.printDiagnostics(output);
    }),
    vscode.commands.registerCommand('deepseekCostMonitor.rebuildLedger', () => monitor.rebuildLedger()),
    vscode.commands.registerCommand('deepseekCostMonitor.clearLedger', () => monitor.clearLedger()),
    vscode.workspace.onDidChangeConfiguration(event => {
      if (event.affectsConfiguration('deepseekCostMonitor')) monitor.reconfigure();
    })
  );

  monitor.start().catch(err => {
    output.appendLine(`启动失败：${err && err.message ? err.message : String(err)}`);
  });
}

function deactivate() {}

module.exports = { activate, deactivate };

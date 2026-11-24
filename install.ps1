$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$packageJson = Join-Path $root 'package.json'
if (-not (Test-Path -LiteralPath $packageJson)) {
    throw "未找到 package.json：$packageJson"
}
$manifest = Get-Content -LiteralPath $packageJson -Raw -Encoding UTF8 | ConvertFrom-Json
$targetName = "$($manifest.publisher).$($manifest.name)-$($manifest.version)"
$target = Join-Path $env:USERPROFILE ".vscode\extensions\$targetName"

New-Item -ItemType Directory -Force -Path $target | Out-Null

$exclude = @('.vscode', 'tools', '.git', 'install.ps1', 'pack.ps1')
Get-ChildItem -LiteralPath $root -Force | Where-Object {
    $exclude -notcontains $_.Name -and $_.Name -notlike '.vsix-stage*' -and $_.Extension -ne '.vsix'
} | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
}

Write-Host "已复制扩展文件到：$target"
Write-Host "下一步：在 VS Code 执行 “Developer: Reload Window”，活动栏将出现 “DeepSeek 消费”。"
Write-Host "若未识别，请改用 F5 开发宿主，或运行 pack.ps1 生成 vsix 后安装。"

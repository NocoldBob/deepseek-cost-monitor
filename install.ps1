# Windows convenience wrapper: install the newest VSIX in this directory.
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$vsix = Get-ChildItem -LiteralPath $root -Filter '*.vsix' -File |
    Sort-Object LastWriteTime -Descending |
    Select-Object -First 1

if (-not $vsix) {
    throw 'No VSIX found. Run .\pack.ps1 first, or download one from Marketplace / Releases.'
}

$codeCmd = Get-Command code.cmd -ErrorAction SilentlyContinue
if ($codeCmd) {
    & $codeCmd.Source --install-extension $vsix.FullName --force
    if ($LASTEXITCODE -ne 0) { throw "Install failed (exit $LASTEXITCODE)" }
} else {
    $codeExe = Get-Command code -ErrorAction SilentlyContinue
    if (-not $codeExe) {
        throw 'The code command was not found. Run "Shell Command: Install code command in PATH" in VS Code first.'
    }
    $process = Start-Process -FilePath $codeExe.Source `
        -ArgumentList @('--install-extension', $vsix.FullName, '--force') `
        -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Install failed (exit $($process.ExitCode))" }
}

Write-Host "Installed: $($vsix.Name)"
Write-Host 'Run "Developer: Reload Window" in VS Code to activate it.'

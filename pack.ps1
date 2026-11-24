# Windows convenience wrapper: packaging is done by vsce (same as npm run package).
$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
Push-Location -LiteralPath $root
try {
    if (-not (Test-Path -LiteralPath (Join-Path $root 'node_modules\.bin\vsce.cmd'))) {
        Write-Host 'Installing packaging dependencies (first run requires network)...'
        npm install
        if ($LASTEXITCODE -ne 0) { throw "npm install failed (exit $LASTEXITCODE)" }
    }

    npm run package
    if ($LASTEXITCODE -ne 0) { throw "vsce packaging failed (exit $LASTEXITCODE)" }

    $manifest = Get-Content -LiteralPath (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    $candidates = @(
        (Join-Path $root "$($manifest.name)-$($manifest.version).vsix"),
        (Join-Path $root "$($manifest.publisher).$($manifest.name)-$($manifest.version).vsix")
    )

    $vsix = $null
    foreach ($candidate in $candidates) {
        if (Test-Path -LiteralPath $candidate) {
            $vsix = $candidate
            break
        }
    }
    if (-not $vsix) { throw 'VSIX output not found. Check the vsce output above.' }

    Write-Host "Created: $vsix"
    Write-Host "Install: code --install-extension `"$vsix`" --force"
} finally {
    Pop-Location
}

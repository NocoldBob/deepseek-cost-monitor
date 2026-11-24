param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$root = $PSScriptRoot
$packageJson = Join-Path $root 'package.json'
if (-not (Test-Path -LiteralPath $packageJson)) {
    throw "未找到 package.json：$packageJson"
}
$manifest = Get-Content -LiteralPath $packageJson -Raw -Encoding UTF8 | ConvertFrom-Json
$identity = "$($manifest.publisher).$($manifest.name)"
$version = "$($manifest.version)"
$stage = Join-Path $root '.vsix-stage'
$extensionDir = Join-Path $stage 'extension'
$outFile = Join-Path $root "$identity-$version.vsix"

if ((Test-Path -LiteralPath $outFile) -and -not $Force) {
    throw "目标文件已存在，为避免覆盖请先手动处理：$outFile"
}

New-Item -ItemType Directory -Force -Path $extensionDir | Out-Null

$exclude = @('.vscode', 'tools', '.git', 'install.ps1', 'pack.ps1', '.vsix-stage')
Get-ChildItem -LiteralPath $root -Force | Where-Object {
    $exclude -notcontains $_.Name -and $_.Name -notlike '.vsix-stage*' -and $_.Extension -ne '.vsix'
} | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination $extensionDir -Recurse -Force
}

$vsixManifest = @"
<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="$identity" Version="$version" Publisher="$($manifest.publisher)" />
    <DisplayName>$($manifest.displayName)</DisplayName>
    <Description xml:space="preserve">$($manifest.description)</Description>
    <Tags>$($manifest.keywords -join ',')</Tags>
    <Categories>Other</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="$($manifest.engines.vscode)" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="ui" />
    </Properties>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
  </Assets>
</PackageManifest>
"@

$contentTypes = @"
<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="vsixmanifest" ContentType="text/xml" />
  <Default Extension="json" ContentType="application/json" />
  <Default Extension="js" ContentType="application/javascript" />
  <Default Extension="css" ContentType="text/css" />
  <Default Extension="svg" ContentType="image/svg+xml" />
</Types>
"@

Set-Content -LiteralPath (Join-Path $stage 'extension.vsixmanifest') -Value $vsixManifest -Encoding utf8
Set-Content -LiteralPath (Join-Path $stage '[Content_Types].xml') -Value $contentTypes -Encoding utf8

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem
$zipStream = [System.IO.File]::Open($outFile, [System.IO.FileMode]::Create)
$archive = New-Object System.IO.Compression.ZipArchive($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
try {
    Get-ChildItem -LiteralPath $stage -Recurse -File | ForEach-Object {
        $relative = $_.FullName.Substring($stage.Length + 1).Replace('\', '/')
        $entry = $archive.CreateEntry($relative, [System.IO.Compression.CompressionLevel]::Optimal)
        $entryStream = $entry.Open()
        $fileStream = [System.IO.File]::OpenRead($_.FullName)
        try {
            $fileStream.CopyTo($entryStream)
        } finally {
            $fileStream.Dispose()
            $entryStream.Dispose()
        }
    }
} finally {
    $archive.Dispose()
    $zipStream.Dispose()
}

Write-Host "已生成：$outFile"
Write-Host "安装命令：code --install-extension `"$outFile`""

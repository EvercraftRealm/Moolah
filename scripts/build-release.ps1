[CmdletBinding()]
param(
    [string]$OutputDirectory = (Join-Path $PSScriptRoot '..\dist')
)

$ErrorActionPreference = 'Stop'
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$behaviorPack = Join-Path $repoRoot 'Moolah BP'
$resourcePack = Join-Path $repoRoot 'Moolah RP'
$behaviorManifestPath = Join-Path $behaviorPack 'manifest.json'
$resourceManifestPath = Join-Path $resourcePack 'manifest.json'

foreach ($requiredPath in @($behaviorManifestPath, $resourceManifestPath)) {
    if (-not (Test-Path -LiteralPath $requiredPath -PathType Leaf)) {
        throw "Required file not found: $requiredPath"
    }
}

$behaviorManifest = Get-Content -Raw -LiteralPath $behaviorManifestPath | ConvertFrom-Json
$resourceManifest = Get-Content -Raw -LiteralPath $resourceManifestPath | ConvertFrom-Json
$behaviorVersion = $behaviorManifest.header.version -join '.'
$resourceVersion = $resourceManifest.header.version -join '.'

if ($behaviorVersion -ne $resourceVersion) {
    throw "Pack versions do not match: behavior=$behaviorVersion, resource=$resourceVersion"
}

$outputRoot = [System.IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("moolah-release-" + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $temporaryRoot | Out-Null

try {
    $behaviorZip = Join-Path $temporaryRoot 'Moolah-BP.zip'
    $resourceZip = Join-Path $temporaryRoot 'Moolah-RP.zip'
    $behaviorMcpack = Join-Path $temporaryRoot 'Moolah-BP.mcpack'
    $resourceMcpack = Join-Path $temporaryRoot 'Moolah-RP.mcpack'
    $addonZip = Join-Path $temporaryRoot "Moolah-$behaviorVersion.zip"
    $addonPath = Join-Path $outputRoot "Moolah-$behaviorVersion.mcaddon"

    Compress-Archive -Path (Join-Path $behaviorPack '*') -DestinationPath $behaviorZip -CompressionLevel Optimal
    Compress-Archive -Path (Join-Path $resourcePack '*') -DestinationPath $resourceZip -CompressionLevel Optimal
    Move-Item -LiteralPath $behaviorZip -Destination $behaviorMcpack
    Move-Item -LiteralPath $resourceZip -Destination $resourceMcpack
    Compress-Archive -Path $behaviorMcpack, $resourceMcpack -DestinationPath $addonZip -CompressionLevel Optimal

    if (Test-Path -LiteralPath $addonPath) {
        Remove-Item -LiteralPath $addonPath -Force
    }
    Move-Item -LiteralPath $addonZip -Destination $addonPath

    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $addonPath).Hash.ToLowerInvariant()
    Write-Output "Built $addonPath"
    Write-Output "SHA256 $hash"
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}


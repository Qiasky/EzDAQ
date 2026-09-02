$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$version = '0.1.0'
$releaseRoot = Join-Path $repositoryRoot "release\EzDAQ-EPS-MVP-$version"
$archivePath = Join-Path $repositoryRoot "release\EzDAQ-EPS-MVP-$version.zip"

if (Test-Path -LiteralPath $releaseRoot) {
    Remove-Item -LiteralPath $releaseRoot -Recurse -Force
}
if (Test-Path -LiteralPath $archivePath) {
    Remove-Item -LiteralPath $archivePath -Force
}

New-Item -ItemType Directory -Path $releaseRoot -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'apps') -Destination (Join-Path $releaseRoot 'apps') -Recurse
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'docker-compose.yml') -Destination $releaseRoot
Copy-Item -LiteralPath (Join-Path $repositoryRoot 'RELEASE.md') -Destination $releaseRoot

Compress-Archive -LiteralPath $releaseRoot -DestinationPath $archivePath
Write-Host "Release archive created: $archivePath"

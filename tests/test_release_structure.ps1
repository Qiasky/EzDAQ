$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$requiredFiles = @(
    'RELEASE.md',
    'docker-compose.yml',
    'apps\center-platform\package.json',
    'apps\center-platform\server.mjs',
    'apps\center-platform\Dockerfile',
    'apps\center-platform\public\index.html',
    'apps\center-platform\test\server.test.mjs',
    'scripts\package-release.ps1'
)

foreach ($file in $requiredFiles) {
    if (-not (Test-Path -LiteralPath (Join-Path $repositoryRoot $file))) {
        throw "Release file is missing: $file"
    }
}

Write-Host 'EzDAQ EPS release structure validation passed.'

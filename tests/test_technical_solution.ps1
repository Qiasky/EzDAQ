$ErrorActionPreference = 'Stop'

$solutionPath = Join-Path (Split-Path -Parent $PSScriptRoot) 'docs\EzDAQ EPS 技术方案.md'
$content = Get-Content -LiteralPath $solutionPath -Raw -Encoding utf8

$requiredText = @(
    'Vue 3',
    'Electron',
    'uni-app',
    'Spring Boot',
    'PostgreSQL',
    'TimescaleDB',
    'MQTT',
    'Modbus TCP',
    'WebSocket',
    'Go'
)

foreach ($text in $requiredText) {
    if ($content -notlike "*$text*") {
        throw "Technical solution is missing: $text"
    }
}

Write-Host 'EzDAQ EPS technical solution validation passed.'

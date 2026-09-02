$ErrorActionPreference = 'Stop'

$repositoryRoot = Split-Path -Parent $PSScriptRoot
$mvpPath = Join-Path $repositoryRoot 'EzDAQ EPS.md'
$content = Get-Content -LiteralPath $mvpPath -Raw -Encoding utf8
$requiredText = @('MVP', 'TCP/IP', 'Modbus TCP', 'Webhook', 'Git commit')
foreach ($text in $requiredText) {
    if ($content -notlike "*$text*") { throw "Missing required MVP content: $text" }
}

$designFile = Get-ChildItem -LiteralPath $repositoryRoot -File -Filter '*.md' |
    Where-Object { $_.Name -ne 'EzDAQ EPS.md' } |
    Select-Object -First 1
if ($null -eq $designFile) { throw 'Product design document was not found.' }

$designContent = Get-Content -LiteralPath $designFile.FullName -Raw -Encoding utf8
$requiredDesignText = @('MVP', 'TCP/IP', 'Modbus TCP', 'Webhook', 'UPS', 'HTTPS')
foreach ($text in $requiredDesignText) {
    if ($designContent -notlike "*$text*") { throw "Missing required product design content: $text" }
}

Write-Host 'EzDAQ EPS document validation passed.'
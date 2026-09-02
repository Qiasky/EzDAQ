$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$demoPath = Join-Path $root 'demo\index.html'
$content = Get-Content -LiteralPath $demoPath -Raw -Encoding utf8
$requiredText = @(
    'data-view="web"',
    'data-view="mobile"',
    'data-view="mini"',
    'data-view="windows"',
    'prototypeVersion',
    'simulate',
    'alertDetail',
    'deviceDetail',
    'addDevice',
    'noticeSetting',
    'renderDemo',
    'data-page="datasources"',
    'function datasources()',
    'dataSources',
    'testDataSource',
    'saveDataSource',
    'dsFieldRender',
    'dsSchema',
    'Modbus TCP',
    'VISA',
    '第三方驱动 DLL',
    'dsNameOf'
)
foreach ($text in $requiredText) {
    if ($content -notlike "*$text*") { throw "Demo is missing interaction: $text" }
}

$scriptCount = [regex]::Matches($content, '<script>[\s\S]*?</script>').Count
if ($scriptCount -ne 1) { throw "Demo must contain exactly one executable inline script; found $scriptCount." }

Write-Host 'EzDAQ EPS standalone interactive demo validation passed.'
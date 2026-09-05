$ErrorActionPreference = 'Stop'

Write-Host 'Starting EzDAQ EPS MVP at http://localhost:18080'
node (Join-Path $PSScriptRoot 'server.mjs')

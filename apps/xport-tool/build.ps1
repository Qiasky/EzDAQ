$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$python = Join-Path $PSScriptRoot '.build\venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $python)) {
    python -m venv .build\venv
    if ($LASTEXITCODE -ne 0) { throw 'Failed to create build environment' }
    & $python -m pip install pyinstaller
    if ($LASTEXITCODE -ne 0) { throw 'Failed to install PyInstaller' }
}
$appName = 'XPort' + [char]0x6E29 + [char]0x6E7F + [char]0x5EA6 + [char]0x5DE5 + [char]0x5177
& $python -m PyInstaller --noconfirm --clean --onefile --windowed --name $appName --distpath ..\..\release\xport-tool --workpath .build\pyinstaller --specpath .build app.py
if ($LASTEXITCODE -ne 0) { throw 'EXE build failed' }
$binaryDir = Join-Path $PSScriptRoot 'bin'
New-Item -ItemType Directory -Path $binaryDir -Force | Out-Null
$releaseExe = Join-Path $PSScriptRoot "..\..\release\xport-tool\$appName.exe"
Copy-Item -LiteralPath $releaseExe -Destination (Join-Path $binaryDir "$appName.exe") -Force

$ErrorActionPreference = 'Stop'
$powerRoot = $PSScriptRoot
$powerPython = Join-Path $powerRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $powerPython)) { py -3.13 -m venv (Join-Path $powerRoot '.venv') }
& $powerPython -m pip install -r (Join-Path $powerRoot 'requirements.txt')
if ($LASTEXITCODE -ne 0) { throw '依赖安装失败' }
& $powerPython -m pip install --no-deps -e (Join-Path $powerRoot 'engineering-skills') -e (Join-Path $powerRoot 'seismo-skill-agent')
if ($LASTEXITCODE -ne 0) { throw '本地包安装失败' }
Write-Output 'Installed. Run start-power.cmd to explore the bundled Auckland example without an API key. Run configure-model.cmd to enter your own model settings for new tasks.'

param([int]$Port = 8785, [switch]$Foreground)
$ErrorActionPreference = 'Stop'
$powerRoot = $PSScriptRoot
$powerPython = Join-Path $powerRoot '.venv\Scripts\python.exe'
if (-not (Test-Path -LiteralPath $powerPython)) { throw '请先运行 install-power.ps1 安装本项目独立环境。' }
$env:POWER_WORKSPACE_ROOT = $powerRoot
$env:POWER_AGENT_RUN_ROOT = Join-Path $powerRoot 'runtime\agent-runs'
$env:POWER_SKILL_RUN_ROOT = Join-Path $powerRoot 'runtime\skill-runs'
$env:POWER_KNOWLEDGE_ROOT = Join-Path $powerRoot 'knowledge-base'
$env:SEISMO_KNOWLEDGE_LOCK = Join-Path $powerRoot 'reproducibility\knowledge.lock.json'
$env:PYTHONPATH = (Join-Path $powerRoot 'seismo-skill-agent\src') + ';' + (Join-Path $powerRoot 'engineering-skills\src')
if ($Foreground) {
    & $powerPython -m seismo_skill_agent.web --host 127.0.0.1 --port $Port
    exit $LASTEXITCODE
}
$runtime = Join-Path $powerRoot 'runtime'
New-Item -ItemType Directory -Path $runtime -Force | Out-Null
$listener = Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue
if ($listener) {
    Write-Output "端口 $Port 已有服务。请核对 http://127.0.0.1:$Port ，或指定另一个端口。"
    exit 0
}
$process = Start-Process -FilePath $powerPython -ArgumentList @('-m','seismo_skill_agent.web','--host','127.0.0.1','--port',"$Port") -WorkingDirectory $powerRoot -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runtime 'server.stdout.log') -RedirectStandardError (Join-Path $runtime 'server.stderr.log')
@{pid=$process.Id;port=$Port;root=$powerRoot;executable=$powerPython} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $runtime 'server.json') -Encoding UTF8
Write-Output "PowerSkillAgent: http://127.0.0.1:$Port"

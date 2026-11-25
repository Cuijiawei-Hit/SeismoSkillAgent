$ErrorActionPreference = 'Stop'
$recordPath = Join-Path $PSScriptRoot 'runtime\server.json'
if (-not (Test-Path -LiteralPath $recordPath)) { Write-Output '没有本项目的后台服务记录。'; exit 0 }
$record = Get-Content -LiteralPath $recordPath -Raw | ConvertFrom-Json
if ([System.IO.Path]::GetFullPath($record.root) -ne [System.IO.Path]::GetFullPath($PSScriptRoot)) { throw '服务记录不属于本项目。' }
$expectedPython = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if ($record.executable -ne $expectedPython) { throw '服务解释器与本项目不符。' }
$sessions = Invoke-RestMethod -Uri ("http://127.0.0.1:" + $record.port + '/api/sessions') -TimeoutSec 10
$active = @($sessions.sessions | Where-Object { $_.status -in @('analyzing','executing','processing_feedback','answering','revalidating','finalizing') })
if ($active.Count) { throw '当前仍有分析或计算任务。请完成当前操作后再停止。' }
$listeners = @(Get-NetTCPConnection -State Listen -LocalPort $record.port -ErrorAction SilentlyContinue)
foreach ($listener in $listeners) {
    $owner = Get-CimInstance Win32_Process -Filter ("ProcessId=" + $listener.OwningProcess)
    if ($null -eq $owner -or $owner.CommandLine -notmatch 'seismo_skill_agent\.web') { throw '端口由其他程序占用，未停止任何进程。' }
    if ($owner.ProcessId -ne $record.pid -and $owner.ParentProcessId -ne $record.pid -and $owner.ExecutablePath -ne $expectedPython) { throw '无法确认服务进程归属，未停止任何进程。' }
    Stop-Process -Id $owner.ProcessId
}
Write-Output 'PowerSkillAgent后台服务已停止；会话、计算结果和检查点保留。'

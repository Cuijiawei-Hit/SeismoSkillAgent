param([string]$BaseUrl = 'https://api.deepseek.com/v1', [string]$Model = 'deepseek-v4-pro')
$ErrorActionPreference = 'Stop'
$modelEndpoint = Read-Host "OpenAI-compatible API base URL [$BaseUrl]"
if ($modelEndpoint) { $BaseUrl = $modelEndpoint.Trim() }
if (-not $BaseUrl.StartsWith('https://')) { throw 'The API base URL must use HTTPS.' }
$modelChoice = Read-Host "Model name [$Model]"
if ($modelChoice) { $Model = $modelChoice.Trim() }
$modelSecret = Read-Host 'Enter your own API key (hidden; not written to a file)' -AsSecureString
if ($modelSecret.Length -eq 0) { throw 'An API key is required for new agent tasks. The saved example needs no key.' }
$modelPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($modelSecret)
try { $env:DEEPSEEK_API_KEY = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($modelPointer) }
finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($modelPointer) }
$env:DEEPSEEK_BASE_URL = $BaseUrl
$env:DEEPSEEK_MODEL = $Model
if (Test-Path -LiteralPath (Join-Path $PSScriptRoot 'runtime/server.json')) {
    & (Join-Path $PSScriptRoot 'stop-power.ps1')
    for ($modelWait = 0; $modelWait -lt 20; $modelWait++) {
        if (-not (Get-NetTCPConnection -State Listen -LocalPort 8785 -ErrorAction SilentlyContinue)) { break }
        Start-Sleep -Milliseconds 250
    }
}
& (Join-Path $PSScriptRoot 'start-power.ps1')
Write-Output 'Model configuration is active in the local server process. No key was saved in the package or a configuration file.'

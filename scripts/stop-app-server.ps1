$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkDir = Join-Path $ProjectRoot 'work'
$PidPath = Join-Path $WorkDir 'bridge-app-server.pid'

if (-not (Test-Path -LiteralPath $PidPath)) {
    Write-Output 'No bridge App Server PID file exists.'
    exit 0
}

$ServerPid = [int](Get-Content -Raw -LiteralPath $PidPath)
$Process = Get-Process -Id $ServerPid -ErrorAction SilentlyContinue
if ($Process) {
    Stop-Process -Id $ServerPid
    $Process.WaitForExit(5000)
}
Remove-Item -LiteralPath $PidPath -Force
Write-Output "Bridge App Server stopped (PID $ServerPid)."

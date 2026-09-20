$ErrorActionPreference = 'Stop'

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$WorkDir = Join-Path $ProjectRoot 'work'
$ListenHost = '127.0.0.1'
$ListenPort = 47635
$PidPath = Join-Path $WorkDir 'bridge-app-server.pid'
$StdoutPath = Join-Path $WorkDir 'bridge-app-server.stdout.log'
$StderrPath = Join-Path $WorkDir 'bridge-app-server.stderr.log'

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null

if (Test-Path -LiteralPath $PidPath) {
    $ExistingPid = [int](Get-Content -Raw -LiteralPath $PidPath)
    if (Get-Process -Id $ExistingPid -ErrorAction SilentlyContinue) {
        Write-Output "App Server is already running (PID $ExistingPid)."
        exit 0
    }
    Remove-Item -LiteralPath $PidPath -Force
}

$CodexPath = (Get-Command codex -ErrorAction Stop).Source
$ListenUrl = "ws://${ListenHost}:${ListenPort}"
$Process = Start-Process -FilePath $CodexPath `
    -ArgumentList @('app-server', '--listen', $ListenUrl) `
    -WorkingDirectory $ProjectRoot `
    -RedirectStandardOutput $StdoutPath `
    -RedirectStandardError $StderrPath `
    -WindowStyle Hidden `
    -PassThru

Set-Content -LiteralPath $PidPath -Value $Process.Id -Encoding ascii

$Ready = $false
for ($Attempt = 0; $Attempt -lt 50; $Attempt++) {
    if ($Process.HasExited) {
        $ErrorText = if (Test-Path -LiteralPath $StderrPath) { Get-Content -Raw -LiteralPath $StderrPath } else { '' }
        throw "App Server exited early with code $($Process.ExitCode). $ErrorText"
    }
    $Client = [System.Net.Sockets.TcpClient]::new()
    try {
        $Client.Connect($ListenHost, $ListenPort)
        $Ready = $true
        break
    } catch {
    } finally {
        $Client.Dispose()
    }
    Start-Sleep -Milliseconds 200
}

if (-not $Ready) {
    throw "App Server did not listen within 10 seconds: $ListenUrl"
}

Write-Output "App Server ready (PID $($Process.Id)): $ListenUrl"

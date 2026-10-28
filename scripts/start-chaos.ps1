$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath (Split-Path -Parent $PSScriptRoot)
$browserJob = $null

try {
    if (-not (Get-Command node -ErrorAction SilentlyContinue) -or
        -not (Get-Command npm.cmd -ErrorAction SilentlyContinue)) {
        throw 'Please install Node.js 22.12 or newer, then double-click start-chaos.cmd again.'
    }
    & node -e "const [major, minor] = process.versions.node.split('.').map(Number); process.exit(major > 22 || (major === 22 && minor >= 12) ? 0 : 1)"
    if ($LASTEXITCODE -ne 0) { throw 'Node.js 22.12 or newer is required.' }

    $port = if ($env:ATLAS_PORT) { [int]$env:ATLAS_PORT } else { 4317 }
    if ($port -lt 1 -or $port -gt 65535) { throw 'ATLAS_PORT must be between 1 and 65535.' }
    $url = "http://127.0.0.1:$port"
    $existing = $null
    try {
        $existing = Invoke-WebRequest "$url/api/session" -UseBasicParsing -TimeoutSec 2
    } catch { }
    if ($existing -and $existing.Headers['X-Atlas-Contract']) {
        Write-Host "CHAOS is already running. Opening $url"
        Start-Process $url
        exit 0
    }

    if (-not (Test-Path -LiteralPath 'node_modules/.bin/tsx.cmd') -or
        -not (Test-Path -LiteralPath 'node_modules/.bin/vite.cmd')) {
        Write-Host 'Installing dependencies (first launch requires internet access)...'
        & npm.cmd ci
        if ($LASTEXITCODE -ne 0) { throw 'Dependency installation failed. Check the output above and try again.' }
    }

    Write-Host 'Building CHAOS...'
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed. Check the output above.' }

    # Open the browser only after the local service responds, not after a fixed delay.
    $browserJob = Start-Job -ArgumentList $url -ScriptBlock {
        param($url)
        for ($attempt = 0; $attempt -lt 60; $attempt++) {
            try {
                $response = Invoke-WebRequest "$url/api/session" -UseBasicParsing -TimeoutSec 1
                if ($response.Headers['X-Atlas-Contract']) {
                    Start-Process $url
                    return
                }
            } catch { }
            Start-Sleep -Seconds 1
        }
    }
    Write-Host "Starting CHAOS at $url"
    Write-Host 'Keep this window open while using CHAOS. Press Ctrl+C to stop.'
    & npm.cmd start
    if ($LASTEXITCODE -ne 0) { throw 'CHAOS stopped with an error. Check the output above.' }
} catch {
    Write-Host "`n$($_.Exception.Message)" -ForegroundColor Red
    exit 1
} finally {
    if ($browserJob) {
        Stop-Job -Job $browserJob
        Remove-Job -Job $browserJob -Force
    }
}

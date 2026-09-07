[CmdletBinding()]
param(
    [Parameter(ValueFromRemainingArguments = $true)]
    [string[]]$BridgeArgs
)
$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$SetupScript = Join-Path $PSScriptRoot "setup-bridge.ps1"
$VenvPython = Join-Path $RepoRoot ".venv\Scripts\python.exe"

if (-not (Test-Path -LiteralPath $VenvPython)) {
    Write-Host "[INFO] First run: preparing the Python bridge environment..."
    & $SetupScript
    if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $VenvPython)) {
        throw "Bridge setup failed. See messages above."
    }
} else {
    & $VenvPython -c "import fastapi, uvicorn, numpy, torch" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[INFO] Detected an incomplete .venv; re-running setup..."
        & $SetupScript
        if ($LASTEXITCODE -ne 0) { throw "Bridge setup failed. See messages above." }
    }
}

function Find-Exe([string]$Name) {
    $cmd = Get-Command $Name -ErrorAction SilentlyContinue
    if ($cmd) { return $cmd.Source }
    $lookup = @(
        (Join-Path $RepoRoot "ffmpeg\bin\$Name.exe"),
        "C:\ffmpeg\bin\$Name.exe"
    )
    foreach ($path in $lookup) {
        if (Test-Path -LiteralPath $path) { return $path }
    }
    return $null
}

if (-not $env:FFMPEG_BIN) {
    $ffmpeg = Find-Exe "ffmpeg"
    if ($ffmpeg) { $env:FFMPEG_BIN = $ffmpeg }
}
if (-not $env:FFPLAY_BIN) {
    $ffplay = Find-Exe "ffplay"
    if ($ffplay) { $env:FFPLAY_BIN = $ffplay }
}

Write-Host "[INFO] FFMPEG_BIN=$env:FFMPEG_BIN"
Write-Host "[INFO] FFPLAY_BIN=$env:FFPLAY_BIN"
Write-Host "[INFO] Starting dsh-chinese-talk bridge on http://127.0.0.1:8766 (Ctrl+C to stop)."
Write-Host ""

Push-Location $RepoRoot
try {
    & $VenvPython -m bridge.record_sink @BridgeArgs
    $code = $LASTEXITCODE
} finally {
    Pop-Location
}

if ($code -ne 0) {
    Write-Host ""
    Write-Host "[ERROR] Bridge exited with code $code."
}
exit $code

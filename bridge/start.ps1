$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$candidates = @(
    (Join-Path $root '.venv\Scripts\python.exe'),
    (Join-Path $root 'venv-speech\Scripts\python.exe')
)
$python = $candidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
if ($null -eq $python) {
    $python = (Get-Command python -ErrorAction SilentlyContinue).Source
}
if ([string]::IsNullOrWhiteSpace($python)) {
    throw 'Python not found. Create .venv or add python to PATH.'
}

Push-Location $root
try {
    & $python -m bridge.record_sink @args
} finally {
    Pop-Location
}

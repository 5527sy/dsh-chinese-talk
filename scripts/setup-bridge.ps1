[CmdletBinding()]
param(
    [string]$Python = "",
    [switch]$SkipInstall,
    [string]$TorchIndexUrl = ""
)
$ErrorActionPreference = "Stop"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$VenvDir = Join-Path $RepoRoot ".venv"
$VenvPython = Join-Path $VenvDir "Scripts\python.exe"

function Get-PythonVersion([string]$Exe) {
    $line = & $Exe -c "import sys; print(f'{sys.version_info.major}.{sys.version_info.minor}')" 2>$null | Select-Object -Last 1
    if ($line) { return $line.Trim() }
    return ""
}

function Test-CompatiblePython([string]$Version) {
    if ($Version -match "^3\.(10|11|12|13)$") { return $true }
    return $false
}

function Get-PythonCandidates {
    $found = New-Object System.Collections.Generic.List[string]

    if ($Python -and (Test-Path -LiteralPath $Python)) {
        $found.Add((Resolve-Path -LiteralPath $Python).Path)
    }

    $py = Get-Command py -ErrorAction SilentlyContinue
    if ($py) {
        try {
            $lines = & py -0p 2>$null
            foreach ($line in $lines) {
                $m = [regex]::Match($line, "^\s*-\d+\.\d+(?:-\d+)?\s+(.+)$")
                if ($m.Success) {
                    $candidate = $m.Groups[1].Value.Trim()
                    if (Test-Path -LiteralPath $candidate) { $found.Add($candidate) }
                }
            }
        } catch { }
    }

    $common = @(
        (Join-Path $RepoRoot ".venv\Scripts\python.exe"),
        (Join-Path $RepoRoot "venv-speech\Scripts\python.exe"),
        "C:\Python313\python.exe",
        "C:\Python312\python.exe",
        "C:\Python311\python.exe",
        "C:\Python310\python.exe",
        "D:\python-anaconda\python.exe"
    )
    foreach ($candidate in $common) {
        if (Test-Path -LiteralPath $candidate) { $found.Add($candidate) }
    }

    $cmd = Get-Command python -ErrorAction SilentlyContinue
    if ($cmd) { $found.Add($cmd.Source) }

    return ($found | Select-Object -Unique)
}

$candidates = Get-PythonCandidates
if ($candidates.Count -eq 0) {
    throw "Python was not found. Install Python 3.10-3.13 and add it to PATH, or pass -Python <path>."
}

$selected = $null
foreach ($candidate in $candidates) {
    $ver = Get-PythonVersion $candidate
    if (Test-CompatiblePython $ver) { $selected = $candidate; break }
}
if (-not $selected) {
    $selected = $candidates[0]
    Write-Host "[WARN] Preferred Python 3.10-3.13 not found; using $selected. FunASR/torch may lack wheels on very new Python."
}

$verText = Get-PythonVersion $selected
Write-Host "[INFO] Using Python $selected ($verText)"

if (-not (Test-Path -LiteralPath $VenvPython)) {
    Write-Host "[INFO] Creating virtualenv: $VenvDir"
    & $selected -m venv $VenvDir
    if ($LASTEXITCODE -ne 0) { throw "Failed to create virtualenv with $selected" }
}

if (-not $SkipInstall) {
    Write-Host "[INFO] Upgrading pip..."
    & $VenvPython -m pip install --upgrade pip
    if ($LASTEXITCODE -ne 0) { throw "Failed to upgrade pip" }

    Write-Host "[INFO] Installing bridge/requirements.txt (this can take a while on first run)..."
    & $VenvPython -m pip install --no-input -r (Join-Path $RepoRoot "bridge\requirements.txt")
    if ($LASTEXITCODE -ne 0) { throw "Failed to install bridge requirements" }

    & $VenvPython -c "import torch" 2>$null
    if ($LASTEXITCODE -ne 0) {
        Write-Host "[INFO] PyTorch is missing; installing CPU wheels for FunASR STT..."
        if ($TorchIndexUrl) {
            & $VenvPython -m pip install --no-input torch torchaudio --index-url $TorchIndexUrl
        } else {
            & $VenvPython -m pip install --no-input torch torchaudio --index-url https://download.pytorch.org/whl/cpu
        }
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to install torch/torchaudio. To use a CUDA build, re-run with -TorchIndexUrl https://download.pytorch.org/whl/cu126"
        }
    }
}

Write-Host "[OK] Bridge Python environment ready: $VenvPython"
Write-Output $VenvPython

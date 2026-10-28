<#
.SYNOPSIS
    GradPrep AI - Voice Service Setup Script for Windows
    Downloads Piper binary and English voice models (HFC female + HFC male).

.DESCRIPTION
    1. Creates the voice-service virtual environment.
    2. Installs Python dependencies.
    3. Downloads the Piper Windows binary from the official GitHub release.
    4. Downloads en_US-hfc_female-medium and en_US-hfc_male-medium models.
    5. Writes a starter .env for the voice service.

.NOTES
    Requires: Python 3.10+ on PATH, internet access.
    Run from the repository root:  .\voice-service\setup_models.ps1
#>

param(
    [switch]$Force   # re-download even if files exist
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

# ── Paths ───────────────────────────────────────────────────────────────────
$ScriptDir   = $PSScriptRoot
$ModelsDir   = Join-Path $ScriptDir "models"
$BinDir      = Join-Path $ScriptDir "bin"
$VenvDir     = Join-Path $ScriptDir ".venv"

# ── Piper release info ──────────────────────────────────────────────────────
# Official Windows x86_64 release from https://github.com/rhasspy/piper/releases
$PiperVersion = "2023.11.14-2"
$PiperZipUrl  = "https://github.com/rhasspy/piper/releases/download/$PiperVersion/piper_windows_amd64.zip"
$PiperZipPath = Join-Path $ScriptDir "piper_windows.zip"
$PiperExe     = Join-Path $BinDir "piper.exe"

# ── Voice model base URL ─────────────────────────────────────────────────────
# Hugging Face mirror of the official Piper models
$ModelBase = "https://huggingface.co/rhasspy/piper-voices/resolve/main"

$Models = @(
    @{
        VoiceId    = "en_female"
        OnnxUrl    = "$ModelBase/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx"
        JsonUrl    = "$ModelBase/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx.json"
        OnnxFile   = "en_US-hfc_female-medium.onnx"
        JsonFile   = "en_US-hfc_female-medium.onnx.json"
        Description = "Female - en_US-hfc_female-medium (MIT)"
    },
    @{
        VoiceId    = "en_male"
        OnnxUrl    = "$ModelBase/en/en_US/hfc_male/medium/en_US-hfc_male-medium.onnx"
        JsonUrl    = "$ModelBase/en/en_US/hfc_male/medium/en_US-hfc_male-medium.onnx.json"
        OnnxFile   = "en_US-hfc_male-medium.onnx"
        JsonFile   = "en_US-hfc_male-medium.onnx.json"
        Description = "Male - en_US-hfc_male-medium (MIT)"
    }
)

# ── Helpers ──────────────────────────────────────────────────────────────────
function Write-Step($msg) {
    Write-Host "`n==> $msg" -ForegroundColor Cyan
}

function Download-File($url, $dest) {
    if ((Test-Path $dest) -and -not $Force) {
        Write-Host "  Already exists: $dest" -ForegroundColor DarkGray
        return
    }
    Write-Host "  Downloading $url"
    Write-Host "        -> $dest"
    $ProgressPreference = "SilentlyContinue"
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
}

# ── 1. Check Python ──────────────────────────────────────────────────────────
Write-Step "Checking Python installation"
try {
    $pyVersion = & python --version 2>&1
    Write-Host "  Found: $pyVersion" -ForegroundColor Green
} catch {
    Write-Error "Python not found on PATH. Install Python 3.10+ from https://python.org and add it to PATH."
}

# ── 2. Create virtual environment ────────────────────────────────────────────
Write-Step "Creating Python virtual environment"
if (-not (Test-Path $VenvDir)) {
    & python -m venv $VenvDir
    Write-Host "  Created: $VenvDir" -ForegroundColor Green
} else {
    Write-Host "  Already exists: $VenvDir" -ForegroundColor DarkGray
}

$PipExe = Join-Path $VenvDir "Scripts\pip.exe"

# ── 3. Install Python dependencies ───────────────────────────────────────────
Write-Step "Installing Python dependencies"
& $PipExe install --upgrade pip --quiet
& $PipExe install -r (Join-Path $ScriptDir "requirements.txt")
Write-Host "  Dependencies installed." -ForegroundColor Green

# ── 4. Download Piper binary ──────────────────────────────────────────────────
Write-Step "Downloading Piper binary"
if (-not (Test-Path $BinDir)) { New-Item -ItemType Directory -Path $BinDir | Out-Null }

if ((Test-Path $PiperExe) -and -not $Force) {
    Write-Host "  Piper already present: $PiperExe" -ForegroundColor DarkGray
} else {
    Download-File $PiperZipUrl $PiperZipPath
    Write-Host "  Extracting Piper..."
    $ExtractTmp = Join-Path $ScriptDir "_piper_extract_tmp"
    if (Test-Path $ExtractTmp) { Remove-Item $ExtractTmp -Recurse -Force }
    Expand-Archive -Path $PiperZipPath -DestinationPath $ExtractTmp -Force

    # The archive extracts into a sub-folder called 'piper'
    $ExtractedDir = Join-Path $ExtractTmp "piper"

    # Move piper.exe
    Move-Item (Join-Path $ExtractedDir "piper.exe") $PiperExe -Force

    # Copy all DLLs and supporting files alongside piper.exe
    Get-ChildItem $ExtractedDir -Filter "*.dll" | ForEach-Object {
        Copy-Item $_.FullName $BinDir -Force
    }
    Get-ChildItem $ExtractedDir -Filter "*.ort" | ForEach-Object {
        Copy-Item $_.FullName $BinDir -Force
    }

    # Copy espeak-ng-data — required for phoneme synthesis on Windows
    $EspeakSrc = Join-Path $ExtractedDir "espeak-ng-data"
    $EspeakDst = Join-Path $BinDir "espeak-ng-data"
    if (Test-Path $EspeakSrc) {
        if (Test-Path $EspeakDst) { Remove-Item $EspeakDst -Recurse -Force }
        Copy-Item $EspeakSrc $EspeakDst -Recurse -Force
        Write-Host "  Copied espeak-ng-data" -ForegroundColor Green
    }

    Remove-Item $ExtractTmp -Recurse -Force -ErrorAction SilentlyContinue
    Remove-Item $PiperZipPath -Force -ErrorAction SilentlyContinue
    Write-Host "  Piper binary ready: $PiperExe" -ForegroundColor Green
}

# ── 5. Download voice models ─────────────────────────────────────────────────
Write-Step "Downloading Piper voice models"
if (-not (Test-Path $ModelsDir)) { New-Item -ItemType Directory -Path $ModelsDir | Out-Null }

foreach ($m in $Models) {
    Write-Host "`n  Model: $($m.Description)"
    Download-File $m.OnnxUrl (Join-Path $ModelsDir $m.OnnxFile)
    Download-File $m.JsonUrl (Join-Path $ModelsDir $m.JsonFile)
}

# ── 6. Write .env if missing ─────────────────────────────────────────────────
Write-Step "Writing voice-service .env"
$EnvPath = Join-Path $ScriptDir ".env"
$PiperExeEscaped = $PiperExe -replace "\\", "/"
if (-not (Test-Path $EnvPath)) {
    $envContent = @"
PIPER_EXECUTABLE=$PiperExeEscaped
MODELS_DIR=./models
VOICE_SERVICE_PORT=8001
ALLOWED_ORIGINS=http://localhost:5173,http://localhost:8001
API_SECRET_KEY=
"@
    Set-Content -Path $EnvPath -Value $envContent
    Write-Host "  Written: $EnvPath" -ForegroundColor Green
} else {
    Write-Host "  Already exists (not overwritten): $EnvPath" -ForegroundColor DarkGray
}

# ── Done ─────────────────────────────────────────────────────────────────────
Write-Host "`n" + ("=" * 60) -ForegroundColor Green
Write-Host "Setup complete!" -ForegroundColor Green
Write-Host ""
Write-Host "To start the voice service:"
Write-Host "  cd voice-service"
Write-Host "  .\.venv\Scripts\Activate.ps1"
Write-Host "  python main.py"
Write-Host ""
Write-Host "Health check (once running):"
Write-Host "  Invoke-WebRequest http://localhost:8001/health | Select-Object -Expand Content"
Write-Host ""
Write-Host "Voice previews:"
Write-Host "  Invoke-WebRequest http://localhost:8001/preview/en_female -OutFile female.wav"
Write-Host "  Invoke-WebRequest http://localhost:8001/preview/en_male   -OutFile male.wav"
Write-Host ""
Write-Host "Then start the frontend:"
Write-Host "  cd .. ; npm run dev"

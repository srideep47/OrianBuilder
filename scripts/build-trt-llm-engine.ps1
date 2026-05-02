<#
.SYNOPSIS
  OrianBuilder TensorRT-LLM engine builder.
  Installs TRT Python wheel if needed, then builds a TRT engine for a small Qwen model.

.PARAMETER ModelId
  HuggingFace model ID. Default: Qwen/Qwen2.5-0.5B-Instruct

.PARAMETER OutputDir
  Where to write the compiled engine. Default: %APPDATA%\OrianBuilder\models\trt_engines\<model>

.PARAMETER MaxInputLen
  Max prompt tokens. Default: 4096

.PARAMETER MaxOutputLen
  Max generation tokens. Default: 2048

.PARAMETER Dtype
  Precision: fp16 or fp32. Default: fp16

.PARAMETER TensorRtRoot
  Path to TensorRT install. Default: C:\NVIDIA\TensorRT-10.16.1.11
#>
param(
  [string]$ModelId      = "Qwen/Qwen2.5-0.5B-Instruct",
  [string]$OutputDir    = "",
  [int]   $MaxInputLen  = 4096,
  [int]   $MaxOutputLen = 2048,
  [string]$Dtype        = "fp16",
  [string]$TensorRtRoot = ""
)

$ErrorActionPreference = "Stop"

# ── Resolve TensorRT root ─────────────────────────────────────────────────────
if (-not $TensorRtRoot) { $TensorRtRoot = $env:TENSORRT_ROOT }
if (-not $TensorRtRoot) { $TensorRtRoot = $env:ORIAN_TENSORRT_ROOT }
if ((-not $TensorRtRoot) -and (Test-Path "C:\NVIDIA\TensorRT-10.16.1.11")) {
  $TensorRtRoot = "C:\NVIDIA\TensorRT-10.16.1.11"
}
if (-not $TensorRtRoot) {
  Write-Error "TensorRT not found. Set TENSORRT_ROOT or pass -TensorRtRoot."
  exit 1
}
Write-Host "[check] TensorRT root: $TensorRtRoot"

# ── trtexec ───────────────────────────────────────────────────────────────────
$trtexec = Join-Path $TensorRtRoot "bin\trtexec.exe"
if (-not (Test-Path $trtexec)) {
  Write-Error "trtexec.exe not found at: $trtexec"
  exit 1
}
Write-Host "[check] trtexec: $trtexec"

# ── nvidia-smi ────────────────────────────────────────────────────────────────
$nvsmi = Get-Command nvidia-smi -ErrorAction SilentlyContinue
if (-not $nvsmi) {
  Write-Error "nvidia-smi not found. Install NVIDIA display driver."
  exit 1
}
$gpuLine = (nvidia-smi --query-gpu=name,driver_version,memory.total,compute_cap --format=csv,noheader,nounits 2>$null) | Select-Object -First 1
Write-Host "[check] GPU: $gpuLine"

# ── Python ────────────────────────────────────────────────────────────────────
if (-not (Get-Command python -ErrorAction SilentlyContinue)) {
  Write-Error "python not found on PATH."
  exit 1
}
$pyver = (python --version 2>&1)
Write-Host "[check] Python: $pyver"

# ── Add TensorRT bin to PATH before any Python import checks ─────────────────
$trtBin = Join-Path $TensorRtRoot "bin"
$env:PATH = "$trtBin;$env:PATH"
$env:TENSORRT_ROOT = $TensorRtRoot
Write-Host "[check] Added to PATH: $trtBin"

# ── Install TensorRT Python wheel if not already installed ────────────────────
$trtVer = (python -c "import tensorrt; print(tensorrt.__version__)" 2>$null)
if (-not $trtVer) {
  Write-Host "[install] Installing TensorRT Python wheel..."
  $pyMinor = (python -c "import sys; print(sys.version_info.minor)" 2>$null)
  $whlPattern = Join-Path $TensorRtRoot "python\tensorrt-*-cp3${pyMinor}-none-win_amd64.whl"
  $whl = Get-ChildItem $whlPattern -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $whl) {
    Write-Error "TensorRT Python wheel not found matching: $whlPattern"
    exit 1
  }
  Write-Host "[install] Wheel: $($whl.FullName)"
  python -m pip install $whl.FullName --quiet
  if ($LASTEXITCODE -ne 0) {
    Write-Error "pip install failed."
    exit 1
  }
  Write-Host "[install] TensorRT Python wheel installed."
} else {
  Write-Host "[check] TensorRT Python already installed: $trtVer"
}

# ── Check required Python packages ────────────────────────────────────────────
$requiredPkgs = @("torch", "transformers", "numpy")
foreach ($pkg in $requiredPkgs) {
  $ver = (python -c "import $pkg; print($pkg.__version__)" 2>$null)
  if (-not $ver) {
    Write-Error "$pkg not installed. Run: pip install $pkg"
    exit 1
  }
  $label = "[check] ${pkg}: $ver"
  Write-Host $label
}

# ── Resolve output dir ────────────────────────────────────────────────────────
if (-not $OutputDir) {
  $safeName = ($ModelId -replace "[/\\:]", "-").ToLower()
  $OutputDir = Join-Path $env:APPDATA "OrianBuilder\models\trt_engines\$safeName"
}
Write-Host "[build] Output dir: $OutputDir"

# ── Resolve runner script ─────────────────────────────────────────────────────
$repoRoot = Split-Path -Parent $PSScriptRoot
$runnerScript = Join-Path $repoRoot "native\trt-llm-runner\runner.py"
if (-not (Test-Path $runnerScript)) {
  Write-Error "runner.py not found at: $runnerScript"
  exit 1
}
Write-Host "[build] Runner: $runnerScript"

# ── Build request JSON ────────────────────────────────────────────────────────
$buildReq = [ordered]@{
  id           = "build-1"
  type         = "build"
  modelId      = $ModelId
  outputDir    = $OutputDir
  maxInputLen  = $MaxInputLen
  maxOutputLen = $MaxOutputLen
  dtype        = $Dtype
} | ConvertTo-Json -Compress

Write-Host "[build] Starting build for: $ModelId"
Write-Host "[build] This downloads the model (if not cached), exports ONNX, and compiles TRT engine."
Write-Host "[build] Expect 10-40 minutes on first run."
Write-Host ""

# ── Write stdin via a tiny Python wrapper script ──────────────────────────────
# PowerShell 5 cannot pipe strings to a child process stdin directly without
# encoding issues. We write a tiny launcher .py that imports the runner module
# and calls it, injecting the request via io.StringIO — no temp files needed.
$launcherPath = Join-Path $env:TEMP "orian_launcher.py"
# Escape backslashes and double-quotes for embedding in a Python string literal
$escapedRunner  = $runnerScript  -replace '\\', '\\'
$escapedBuildReq = $buildReq -replace '\\', '\\' -replace '"', '\"'

$launcherCode = @"
import sys, io, os
os.environ['PYTHONUNBUFFERED'] = '1'
os.environ['PYTHONIOENCODING'] = 'utf-8'
# Reconfigure stdout/stderr for utf-8 line-buffered output
sys.stdout.reconfigure(encoding='utf-8', line_buffering=True)
sys.stderr.reconfigure(encoding='utf-8', line_buffering=True)
# Feed the build request as stdin
sys.stdin = io.TextIOWrapper(io.BytesIO(b'$escapedBuildReq\n'), encoding='utf-8')
# Run the runner
import importlib.util
spec = importlib.util.spec_from_file_location('runner', r'$escapedRunner')
mod  = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)
mod.main()
"@

[System.IO.File]::WriteAllText($launcherPath, $launcherCode, [System.Text.Encoding]::UTF8)

# ── Launch and stream output ──────────────────────────────────────────────────
$psi = New-Object System.Diagnostics.ProcessStartInfo
$psi.FileName              = "python"
$psi.Arguments             = "-u `"$launcherPath`""
$psi.UseShellExecute       = $false
$psi.RedirectStandardOutput = $true
$psi.RedirectStandardError  = $true
$psi.EnvironmentVariables["PYTHONUNBUFFERED"] = "1"
$psi.EnvironmentVariables["PYTHONIOENCODING"] = "utf-8"
$psi.EnvironmentVariables["TENSORRT_ROOT"]    = $TensorRtRoot
$existingPath = $psi.EnvironmentVariables["PATH"]
if ($existingPath -notlike "*$trtBin*") {
  $psi.EnvironmentVariables["PATH"] = "$trtBin;$existingPath"
}

$proc = New-Object System.Diagnostics.Process
$proc.StartInfo = $psi
$proc.Start() | Out-Null

$done = $false
while (-not $done) {
  $rawLine = $proc.StandardOutput.ReadLine()
  if ($null -eq $rawLine) {
    $done = $true
    break
  }
  $l = $rawLine.Trim()
  if (-not $l) { continue }
  try {
    $msg = $l | ConvertFrom-Json
    if ($msg.type -eq "build_progress") {
      Write-Host "  [$($msg.phase)] $($msg.message)"
    } elseif ($msg.type -eq "build_done") {
      Write-Host ""
      Write-Host "[done] Engine built in $($msg.durationMs) ms"
      Write-Host "[done] Engine directory: $($msg.engineDir)"
      $done = $true
    } elseif ($msg.ok -eq $false) {
      $errMsg = $msg.error
      Write-Host "[error] $errMsg"
      if ($msg.traceback) { Write-Host $msg.traceback }
      $done = $true
    }
  } catch {
    Write-Host "  $l"
  }
}

$proc.WaitForExit()

$stderrContent = $proc.StandardError.ReadToEnd()
if ($stderrContent.Trim()) {
  Write-Host ""
  Write-Host "[stderr (last 30 lines)]"
  ($stderrContent -split "`n") | Select-Object -Last 30 | ForEach-Object { Write-Host "  $_" }
}

Write-Host ""
Write-Host "Engine directory: $OutputDir"
Write-Host "Set this as your TensorRT engine directory in the OrianBuilder Engine screen."

param(
  [string]$ModelId = "Qwen/Qwen3-4B",
  [string]$OutputDir = "$env:APPDATA\OrianBuilder\models\trt_engines\qwen3-4b",
  [string]$OnnxPath = "",
  [int]$MaxBatch = 1,
  [int]$MaxInputLen = 8192,
  [int]$MaxSeqLen = 8192
)

$ErrorActionPreference = "Stop"

function Write-Phase {
  param([string]$Phase, [string]$Message)
  Write-Host "[$Phase] $Message"
}

function Find-CommandPath {
  param([string]$Name)
  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if ($command) {
    return $command.Source
  }
  return $null
}

function Require-Command {
  param([string]$Name, [string]$InstallHint)
  $source = Find-CommandPath $Name
  if (-not $source) {
    throw "$Name was not found. $InstallHint"
  }
  return $source
}

Write-Phase "checking" "Checking NVIDIA GPU, CUDA, and TensorRT prerequisites."
$nvidiaSmi = Require-Command "nvidia-smi" "Install or repair the NVIDIA display driver."
$gpuLine = & $nvidiaSmi --query-gpu=name,driver_version,memory.total,compute_cap --format=csv,noheader,nounits | Select-Object -First 1
Write-Phase "checking" "GPU: $gpuLine"

$nvcc = Get-Command "nvcc" -ErrorAction SilentlyContinue
if ($nvcc) {
  Write-Phase "checking" "CUDA compiler: $($nvcc.Source)"
} else {
  Write-Phase "checking" "CUDA compiler not found on PATH. ONNX builds can still work if TensorRT trtexec is installed."
}

$tensorRtRoot = $env:ORIAN_TENSORRT_ROOT
if (-not $tensorRtRoot) {
  $tensorRtRoot = $env:TENSORRT_ROOT
}
if ($tensorRtRoot) {
  Write-Phase "checking" "TensorRT root: $tensorRtRoot"
} else {
  Write-Phase "checking" "TENSORRT_ROOT is not set. The app may still load TensorRT if PATH contains nvinfer DLLs."
}

$trtexec = Find-CommandPath "trtexec"
if ((-not $trtexec) -and $tensorRtRoot) {
  $rootTrtexec = Join-Path $tensorRtRoot "bin\trtexec.exe"
  if (Test-Path $rootTrtexec) {
    $trtexec = $rootTrtexec
  }
}
if (-not $trtexec) {
  throw "trtexec was not found. Install NVIDIA TensorRT for Windows, add its bin directory to PATH, or set TENSORRT_ROOT before launching the app."
}
Write-Phase "checking" "TensorRT trtexec: $trtexec"

New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$metaPath = Join-Path $OutputDir "engine_meta.json"

if ([string]::IsNullOrWhiteSpace($OnnxPath)) {
  Write-Phase "failed" "No ONNX path was provided."
  Write-Host ""
  Write-Host "The native Windows path currently supports TensorRT engine builds from ONNX with trtexec."
  Write-Host "For Hugging Face model id '$ModelId', a Qwen-to-TensorRT-LLM conversion builder still needs to be supplied for Windows native builds."
  Write-Host "Use an exported ONNX model for smoke testing now, or build/export the Qwen engine with a compatible TensorRT-LLM toolchain and select its engine directory in the app."
  exit 2
}

if (-not (Test-Path $OnnxPath)) {
  throw "ONNX file not found: $OnnxPath"
}

$enginePath = Join-Path $OutputDir "model.plan"
Write-Phase "building" "Building TensorRT engine from ONNX: $OnnxPath"

$trtArgs = @(
  "--onnx=$OnnxPath",
  "--saveEngine=$enginePath",
  "--fp16",
  "--minShapes=input_ids:1x1",
  "--optShapes=input_ids:1x$MaxInputLen",
  "--maxShapes=input_ids:$MaxBatch`x$MaxSeqLen",
  "--memPoolSize=workspace:4096"
)

& $trtexec @trtArgs
if ($LASTEXITCODE -ne 0) {
  throw "trtexec failed with exit code $LASTEXITCODE"
}

$meta = [ordered]@{
  format = "tensorrt-plan"
  modelId = $ModelId
  onnxPath = $OnnxPath
  enginePath = $enginePath
  builtAt = (Get-Date).ToUniversalTime().ToString("o")
  maxBatch = $MaxBatch
  maxInputLen = $MaxInputLen
  maxSeqLen = $MaxSeqLen
}
$meta | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -Path $metaPath

Write-Phase "done" "TensorRT engine built: $enginePath"
Write-Phase "done" "Metadata written: $metaPath"

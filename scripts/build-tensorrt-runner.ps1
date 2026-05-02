param(
  [string]$TensorRtRoot = $env:TENSORRT_ROOT
)

$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$runnerDir = Join-Path $repoRoot "native\tensorrt-runner"
$buildDir = Join-Path $runnerDir "build"

$cmakeArgs = @(
  "-S", $runnerDir,
  "-B", $buildDir,
  "-A", "x64"
)

if ($TensorRtRoot) {
  $cmakeArgs += "-DTENSORRT_ROOT=$TensorRtRoot"
}

cmake @cmakeArgs
cmake --build $buildDir --config Release

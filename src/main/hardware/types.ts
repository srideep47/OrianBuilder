export type GpuVendor = "nvidia" | "amd" | "intel" | "apple" | "unknown";
export type CpuVendor = "amd" | "intel" | "apple" | "unknown";
export type InferenceBackend =
  | "cuda"
  | "rocm"
  | "metal"
  | "vulkan"
  | "directml"
  | "openvino"
  | "cpu";
export type LlmBackend = "cuda" | "rocm" | "metal" | "vulkan" | "cpu";
export type MediaBackend =
  | "cuda"
  | "rocm"
  | "metal"
  | "directml"
  | "openvino"
  | "cpu";

export interface GpuInfo {
  vendor: GpuVendor;
  model: string;
  vramMb: number;
  isIntegrated: boolean;
}

export interface HardwareProfile {
  os: "windows" | "macos" | "linux";
  arch: "x64" | "arm64";
  cpu: {
    vendor: CpuVendor;
    model: string;
    cores: number;
    logicalCores: number;
  };
  gpus: GpuInfo[];
  primaryGpu: GpuInfo | null;
  totalRamMb: number;
  availableBackends: InferenceBackend[];
  bestLlmBackend: LlmBackend;
  bestMediaBackend: MediaBackend;
}

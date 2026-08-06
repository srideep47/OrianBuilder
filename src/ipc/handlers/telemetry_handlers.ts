import {
  getInferenceTelemetry,
  sampleLiveTelemetry,
} from "@/main/telemetry/live_telemetry";

import { telemetryContracts } from "../types/telemetry";
import { createTypedHandler } from "./base";

export function registerTelemetryHandlers(): void {
  createTypedHandler(telemetryContracts.getLiveSample, async () =>
    sampleLiveTelemetry(),
  );

  createTypedHandler(telemetryContracts.getInference, async () =>
    getInferenceTelemetry(),
  );
}

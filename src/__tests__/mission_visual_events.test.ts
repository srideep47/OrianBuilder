import { describe, expect, it } from "vitest";

import { extractMissionVisualEventsForXml } from "@/ipc/utils/mission_visual_events";

describe("mission visual/runtime event extraction", () => {
  it("extracts a successful screenshot event and artifact", () => {
    const result = extractMissionVisualEventsForXml(
      '<dyad-screenshot url="http://localhost:3000" path=".dyad/media/screenshot-123.png"></dyad-screenshot>',
    );
    expect(result.events).toMatchObject([
      {
        eventType: "visual_screenshot_captured",
        gate: "screenshot",
        status: "passed",
        metadata: {
          url: "http://localhost:3000",
          path: ".dyad/media/screenshot-123.png",
        },
      },
    ]);
    expect(result.artifacts).toMatchObject([
      {
        artifactType: "screenshot",
        uri: ".dyad/media/screenshot-123.png",
        mimeType: "image/png",
      },
    ]);
  });

  it("classifies a failed screenshot capture", () => {
    const result = extractMissionVisualEventsForXml(
      '<dyad-screenshot url="http://localhost:3000" error="ECONNREFUSED"></dyad-screenshot>',
    );
    expect(result.events).toMatchObject([
      {
        gate: "screenshot",
        status: "failed",
        metadata: { error: "ECONNREFUSED" },
      },
    ]);
    expect(result.artifacts).toEqual([]);
  });

  it("captures accessibility tree artifact when body present", () => {
    const xml =
      '<dyad-accessibility-tree url="http://localhost:3000">- main\n  - heading "Hello"</dyad-accessibility-tree>';
    const result = extractMissionVisualEventsForXml(xml);
    expect(result.events).toMatchObject([
      {
        eventType: "visual_accessibility_captured",
        gate: "accessibility",
        status: "passed",
      },
    ]);
    expect(result.artifacts).toMatchObject([
      {
        artifactType: "accessibility_tree",
        body: expect.stringContaining("heading"),
      },
    ]);
  });

  it("classifies a clean console gate as passed", () => {
    const xml =
      '<dyad-console-output count="0" filter="errors_and_warnings">No errors and warnings found in the last 2 minutes. The app appears to be running cleanly.</dyad-console-output>';
    const result = extractMissionVisualEventsForXml(xml);
    expect(result.events).toMatchObject([
      {
        eventType: "visual_console_checked",
        gate: "console",
        status: "passed",
        metadata: { filter: "errors_and_warnings", count: 0 },
      },
    ]);
  });

  it("classifies a noisy console gate as failed", () => {
    const xml =
      '<dyad-console-output count="3" filter="errors_and_warnings">[10:00:00] [ERROR] TypeError: foo is not defined</dyad-console-output>';
    const result = extractMissionVisualEventsForXml(xml);
    expect(result.events).toMatchObject([
      {
        gate: "console",
        status: "failed",
        metadata: { count: 3 },
      },
    ]);
    expect(result.artifacts).toMatchObject([
      { artifactType: "console_output" },
    ]);
  });

  it("treats dev-server terminal commands as runtime checks", () => {
    const result = extractMissionVisualEventsForXml(
      '<dyad-terminal-command cmd="npm run dev" exit-code="0">vite ready</dyad-terminal-command>',
    );
    expect(result.events).toMatchObject([
      {
        eventType: "runtime_preview_checked",
        gate: "runtime",
        status: "passed",
        metadata: { command: "npm run dev", exitCode: 0 },
      },
    ]);
  });

  it("extracts managed runtime readiness events and artifacts", () => {
    const result = extractMissionVisualEventsForXml(
      '<dyad-runtime-session status="running" ready="true" url="http://localhost:3000" mode="host" process-id="7" pid="1234" status-code="200">vite ready</dyad-runtime-session>',
    );
    expect(result.events).toMatchObject([
      {
        eventType: "runtime_preview_checked",
        gate: "runtime",
        status: "passed",
        metadata: {
          runtimeStatus: "running",
          ready: true,
          url: "http://localhost:3000",
          mode: "host",
        },
      },
    ]);
    expect(result.artifacts).toMatchObject([
      {
        artifactType: "runtime",
        uri: "http://localhost:3000",
        body: "vite ready",
      },
    ]);
  });

  it("extracts failed managed runtime checks", () => {
    const result = extractMissionVisualEventsForXml(
      '<dyad-runtime-session status="failed" ready="false" url="http://localhost:3000" error="ECONNREFUSED"></dyad-runtime-session>',
    );
    expect(result.events).toMatchObject([
      {
        eventType: "runtime_preview_checked",
        gate: "runtime",
        status: "failed",
        metadata: {
          ready: false,
          error: "ECONNREFUSED",
        },
      },
    ]);
  });

  it("extracts browser-control screenshots as visual artifacts", () => {
    const result = extractMissionVisualEventsForXml(
      '<dyad-browser-action action="screenshot" url="http://localhost:3000" path=".dyad/media/browser-123.png">Screenshot saved.</dyad-browser-action>',
    );
    expect(result.events).toMatchObject([
      {
        eventType: "visual_screenshot_captured",
        gate: "screenshot",
        status: "passed",
        metadata: { source: "browser_control" },
      },
    ]);
    expect(result.artifacts).toMatchObject([
      {
        artifactType: "screenshot",
        uri: ".dyad/media/browser-123.png",
        mimeType: "image/png",
      },
    ]);
  });

  it("ignores non-runtime terminal commands", () => {
    const result = extractMissionVisualEventsForXml(
      '<dyad-terminal-command cmd="ls" exit-code="0">files</dyad-terminal-command>',
    );
    expect(result.events).toEqual([]);
    expect(result.artifacts).toEqual([]);
  });

  it("returns empty result for unrelated XML", () => {
    const result = extractMissionVisualEventsForXml(
      '<dyad-write path="src/App.tsx">code</dyad-write>',
    );
    expect(result.events).toEqual([]);
    expect(result.artifacts).toEqual([]);
  });
});

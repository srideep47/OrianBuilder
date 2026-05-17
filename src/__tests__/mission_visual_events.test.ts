import { describe, expect, it } from "vitest";

import { extractMissionVisualEventsForXml } from "@/ipc/utils/mission_visual_events";

describe("mission visual/runtime event extraction", () => {
  it("extracts a successful screenshot event and artifact", () => {
    const result = extractMissionVisualEventsForXml(
      '<orianbuilder-screenshot url="http://localhost:3000" path=".orianbuilder/media/screenshot-123.png"></orianbuilder-screenshot>',
    );
    expect(result.events).toMatchObject([
      {
        eventType: "visual_screenshot_captured",
        gate: "screenshot",
        status: "passed",
        metadata: {
          url: "http://localhost:3000",
          path: ".orianbuilder/media/screenshot-123.png",
        },
      },
    ]);
    expect(result.artifacts).toMatchObject([
      {
        artifactType: "screenshot",
        uri: ".orianbuilder/media/screenshot-123.png",
        mimeType: "image/png",
      },
    ]);
  });

  it("classifies a failed screenshot capture", () => {
    const result = extractMissionVisualEventsForXml(
      '<orianbuilder-screenshot url="http://localhost:3000" error="ECONNREFUSED"></orianbuilder-screenshot>',
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
      '<orianbuilder-accessibility-tree url="http://localhost:3000">- main\n  - heading "Hello"</orianbuilder-accessibility-tree>';
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
      '<orianbuilder-console-output count="0" filter="errors_and_warnings">No errors and warnings found in the last 2 minutes. The app appears to be running cleanly.</orianbuilder-console-output>';
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
      '<orianbuilder-console-output count="3" filter="errors_and_warnings">[10:00:00] [ERROR] TypeError: foo is not defined</orianbuilder-console-output>';
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
      '<orianbuilder-terminal-command cmd="npm run dev" exit-code="0">vite ready</orianbuilder-terminal-command>',
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
      '<orianbuilder-runtime-session status="running" ready="true" url="http://localhost:3000" mode="host" process-id="7" pid="1234" status-code="200">vite ready</orianbuilder-runtime-session>',
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
      '<orianbuilder-runtime-session status="failed" ready="false" url="http://localhost:3000" error="ECONNREFUSED"></orianbuilder-runtime-session>',
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
      '<orianbuilder-browser-action action="screenshot" url="http://localhost:3000" path=".orianbuilder/media/browser-123.png">Screenshot saved.</orianbuilder-browser-action>',
    );
    expect(result.events).toMatchObject([
      {
        eventType: "visual_screenshot_captured",
        gate: "screenshot",
        status: "passed",
        metadata: { source: "browser_control" },
      },
      {
        eventType: "browser_action_recorded",
        gate: "screenshot",
        status: "passed",
        metadata: { action: "screenshot", source: "browser_control" },
      },
    ]);
    expect(result.artifacts).toMatchObject([
      {
        artifactType: "screenshot",
        uri: ".orianbuilder/media/browser-123.png",
        mimeType: "image/png",
      },
    ]);
  });

  it("extracts browser QA gate events and artifacts", () => {
    const result = extractMissionVisualEventsForXml(
      '<orianbuilder-browser-qa status="passed" runtime-status="passed" runtime-url="http://localhost:3000" screenshot-status="passed" desktop-path=".orianbuilder/media/desktop.png" mobile-path=".orianbuilder/media/mobile.png" accessibility-status="passed" console-status="passed">Accessibility snapshot\n\nConsole clean</orianbuilder-browser-qa>',
    );
    expect(result.events).toMatchObject([
      {
        eventType: "runtime_preview_checked",
        gate: "runtime",
        status: "passed",
        metadata: { source: "browser_qa_gate" },
      },
      {
        eventType: "visual_screenshot_captured",
        gate: "screenshot",
        status: "passed",
        metadata: { viewport: "desktop" },
      },
      {
        eventType: "visual_screenshot_captured",
        gate: "screenshot",
        status: "passed",
        metadata: { viewport: "mobile" },
      },
      {
        eventType: "visual_accessibility_captured",
        gate: "accessibility",
        status: "passed",
      },
      {
        eventType: "visual_console_checked",
        gate: "console",
        status: "passed",
      },
    ]);
    expect(result.artifacts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          artifactType: "screenshot",
          uri: ".orianbuilder/media/desktop.png",
        }),
        expect.objectContaining({
          artifactType: "screenshot",
          uri: ".orianbuilder/media/mobile.png",
        }),
        expect.objectContaining({ artifactType: "accessibility_tree" }),
        expect.objectContaining({ artifactType: "console_output" }),
      ]),
    );
  });

  it("extracts generated image artifacts", () => {
    const result = extractMissionVisualEventsForXml(
      '<orianbuilder-image-generation prompt="hero image" path=".orianbuilder/media/generated.png">.orianbuilder/media/generated.png</orianbuilder-image-generation>',
    );
    expect(result.events).toEqual([]);
    expect(result.artifacts).toMatchObject([
      {
        artifactType: "image",
        title: "Generated image",
        uri: ".orianbuilder/media/generated.png",
        mimeType: "image/png",
        metadata: {
          prompt: "hero image",
          source: "generate_image",
        },
      },
    ]);
  });

  it("extracts deployment artifacts", () => {
    const result = extractMissionVisualEventsForXml(
      '<orianbuilder-deploy-preview provider="vercel" target="preview" ref="main" status="ready" url="https://app.vercel.app" project-id="prj_1" project-name="my-app" state="READY" initial-state="QUEUED" build-log-status="captured" build-log-count="2">Vercel preview deployment ready.\n\nBuild log excerpt:\n[00:00:01] [stdout] build complete</orianbuilder-deploy-preview>',
    );
    expect(result.events).toEqual([]);
    expect(result.artifacts).toMatchObject([
      {
        artifactType: "deployment",
        title: "vercel preview deployment",
        uri: "https://app.vercel.app",
        mimeType: "text/plain",
        metadata: {
          source: "deploy_preview",
          provider: "vercel",
          target: "preview",
          ref: "main",
          status: "ready",
          state: "READY",
          initialState: "QUEUED",
          error: null,
          buildLogStatus: "captured",
          buildLogCount: 2,
          projectId: "prj_1",
          projectName: "my-app",
        },
      },
    ]);
  });

  it("extracts generated audio and video media artifacts", () => {
    const audio = extractMissionVisualEventsForXml(
      '<orianbuilder-media-generation kind="audio" prompt="voiceover" provider="http://localhost:8000" path=".orianbuilder/media/generated.wav" mime-type="audio/wav">audio generated</orianbuilder-media-generation>',
    );
    expect(audio.artifacts).toMatchObject([
      {
        artifactType: "audio",
        title: "Generated audio",
        uri: ".orianbuilder/media/generated.wav",
        mimeType: "audio/wav",
        metadata: {
          source: "generate_media_asset",
          provider: "http://localhost:8000",
        },
      },
    ]);

    const video = extractMissionVisualEventsForXml(
      '<orianbuilder-media-generation kind="video" prompt="demo" provider="http://localhost:8000" path=".orianbuilder/media/generated.mp4" mime-type="video/mp4">video generated</orianbuilder-media-generation>',
    );
    expect(video.artifacts).toMatchObject([
      {
        artifactType: "video",
        title: "Generated video",
        uri: ".orianbuilder/media/generated.mp4",
        mimeType: "video/mp4",
      },
    ]);
  });

  it("ignores non-runtime terminal commands", () => {
    const result = extractMissionVisualEventsForXml(
      '<orianbuilder-terminal-command cmd="ls" exit-code="0">files</orianbuilder-terminal-command>',
    );
    expect(result.events).toEqual([]);
    expect(result.artifacts).toEqual([]);
  });

  it("returns empty result for unrelated XML", () => {
    const result = extractMissionVisualEventsForXml(
      '<orianbuilder-write path="src/App.tsx">code</orianbuilder-write>',
    );
    expect(result.events).toEqual([]);
    expect(result.artifacts).toEqual([]);
  });
});

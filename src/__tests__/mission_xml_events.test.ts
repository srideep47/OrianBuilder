import { describe, expect, it } from "vitest";

import { getMissionStructuredEventsForXml } from "@/ipc/utils/mission_xml_events";

describe("mission XML structured events", () => {
  it("extracts file mutation events", () => {
    expect(
      getMissionStructuredEventsForXml(
        '<dyad-write path="src/App.tsx" description="Update app">code</dyad-write>',
      ),
    ).toMatchObject([
      {
        eventType: "file_written",
        summary: "Wrote src/App.tsx",
        metadata: {
          path: "src/App.tsx",
          action: "write",
          description: "Update app",
        },
      },
    ]);
  });

  it("extracts terminal command events", () => {
    expect(
      getMissionStructuredEventsForXml(
        '<dyad-terminal-command cmd="npm run build" exit-code="1">failed</dyad-terminal-command>',
      ),
    ).toMatchObject([
      {
        eventType: "terminal_command",
        summary: "Command failed: npm run build",
        metadata: {
          command: "npm run build",
          exitCode: 1,
          status: "failed",
        },
      },
    ]);
  });

  it("extracts dependency events", () => {
    expect(
      getMissionStructuredEventsForXml(
        '<dyad-add-dependency packages="react zod"></dyad-add-dependency>',
      ),
    ).toMatchObject([
      {
        eventType: "dependencies_added",
        metadata: {
          packages: ["react", "zod"],
          action: "add_dependency",
        },
      },
    ]);
  });

  it("extracts project creation and post-create verification events", () => {
    expect(
      getMissionStructuredEventsForXml(
        '<dyad-create-project created="true" name="Customer Portal" stack="vite-react-ts" package-manager="pnpm" scaffold-method="starter_files" scaffold-command="" install-command="pnpm install" typecheck-command="pnpm typecheck" build-command="pnpm build" dev-command="pnpm dev" required-checks="install,typecheck,build,runtime,console,screenshot,accessibility">Created</dyad-create-project>',
      ),
    ).toMatchObject([
      {
        eventType: "project_created",
        summary: "Created vite-react-ts project: Customer Portal",
        metadata: {
          action: "create_project",
          created: true,
          stack: "vite-react-ts",
          packageManager: "pnpm",
          requiredChecks: [
            "install",
            "typecheck",
            "build",
            "runtime",
            "console",
            "screenshot",
            "accessibility",
          ],
        },
      },
      {
        eventType: "post_create_verification_required",
        metadata: {
          gate: "post_create_verification",
          status: "required",
          commands: {
            install: "pnpm install",
            typecheck: "pnpm typecheck",
            build: "pnpm build",
            dev: "pnpm dev",
          },
        },
      },
    ]);
  });

  it("extracts project verification runner events", () => {
    expect(
      getMissionStructuredEventsForXml(
        '<dyad-project-verification status="passed" framework="vite" package-manager="pnpm" runtime-status="passed" runtime-url="http://localhost:3000" install-command="pnpm install" install-status="passed" install-exit-code="0" typecheck-command="pnpm typecheck" typecheck-status="passed" typecheck-exit-code="0" build-command="pnpm build" build-status="passed" build-exit-code="0">ok</dyad-project-verification>',
      ),
    ).toMatchObject([
      {
        eventType: "post_create_verification_run",
        metadata: {
          gate: "post_create_verification",
          status: "passed",
        },
      },
      {
        eventType: "verification_install",
        metadata: {
          check: "install",
          status: "passed",
          command: "pnpm install",
          exitCode: 0,
        },
      },
      {
        eventType: "verification_typecheck",
        metadata: {
          check: "typecheck",
          status: "passed",
        },
      },
      {
        eventType: "verification_build",
        metadata: {
          check: "build",
          status: "passed",
        },
      },
      {
        eventType: "runtime_preview_checked",
        metadata: {
          gate: "runtime",
          status: "passed",
          url: "http://localhost:3000",
        },
      },
    ]);
  });
});

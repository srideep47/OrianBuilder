import {
  getDyadAddDependencyTags,
  getDyadCopyTags,
  getDyadDeleteTags,
  getDyadRenameTags,
  getDyadSearchReplaceTags,
  getDyadWriteTags,
} from "./dyad_tag_parser";
import { unescapeXmlAttr } from "../../../shared/xmlEscape";

export type MissionStructuredXmlEvent = {
  eventType: string;
  summary: string;
  metadata: Record<string, unknown>;
};

export function getMissionStructuredEventsForXml(
  xml: string,
): MissionStructuredXmlEvent[] {
  return [
    ...getFileEventsForXml(xml),
    ...getDependencyEventsForXml(xml),
    ...getTerminalEventsForXml(xml),
    ...getProjectEventsForXml(xml),
    ...getProjectVerificationEventsForXml(xml),
  ];
}

function getFileEventsForXml(xml: string): MissionStructuredXmlEvent[] {
  return [
    ...getDyadWriteTags(xml).map((tag) => ({
      eventType: "file_written",
      summary: `Wrote ${tag.path}`,
      metadata: {
        path: tag.path,
        action: "write",
        description: tag.description,
      },
    })),
    ...getDyadSearchReplaceTags(xml).map((tag) => ({
      eventType: "file_modified",
      summary: `Modified ${tag.path}`,
      metadata: {
        path: tag.path,
        action: "search_replace",
        description: tag.description,
      },
    })),
    ...getDyadDeleteTags(xml).map((path) => ({
      eventType: "file_deleted",
      summary: `Deleted ${path}`,
      metadata: { path, action: "delete" },
    })),
    ...getDyadRenameTags(xml).map((tag) => ({
      eventType: "file_renamed",
      summary: `Renamed ${tag.from} to ${tag.to}`,
      metadata: {
        from: tag.from,
        to: tag.to,
        action: "rename",
      },
    })),
    ...getDyadCopyTags(xml).map((tag) => ({
      eventType: "file_copied",
      summary: `Copied ${tag.from} to ${tag.to}`,
      metadata: {
        from: tag.from,
        to: tag.to,
        action: "copy",
        description: tag.description,
      },
    })),
  ];
}

function getDependencyEventsForXml(xml: string): MissionStructuredXmlEvent[] {
  const packages = getDyadAddDependencyTags(xml);
  if (packages.length === 0) {
    return [];
  }

  return [
    {
      eventType: "dependencies_added",
      summary: `Added dependencies: ${packages.join(", ")}`,
      metadata: {
        packages,
        action: "add_dependency",
      },
    },
  ];
}

function getTerminalEventsForXml(xml: string): MissionStructuredXmlEvent[] {
  if (!xml.startsWith("<dyad-terminal-command")) {
    return [];
  }

  const command = getXmlAttribute(xml, "cmd") ?? "terminal command";
  const exitCodeRaw = getXmlAttribute(xml, "exit-code");
  const exitCode = exitCodeRaw ? Number(exitCodeRaw) : undefined;
  const status =
    exitCode === undefined || Number.isNaN(exitCode)
      ? "running"
      : exitCode === 0
        ? "passed"
        : "failed";

  return [
    {
      eventType: "terminal_command",
      summary:
        status === "running"
          ? `Running command: ${command}`
          : `Command ${status}: ${command}`,
      metadata: {
        command,
        exitCode,
        status,
      },
    },
  ];
}

function getProjectEventsForXml(xml: string): MissionStructuredXmlEvent[] {
  if (!xml.startsWith("<dyad-create-project")) {
    return [];
  }

  const created = getXmlAttribute(xml, "created") === "true";
  const name = getXmlAttribute(xml, "name") ?? "project";
  const stack = getXmlAttribute(xml, "stack") ?? "unknown";
  const packageManager = getXmlAttribute(xml, "package-manager") ?? "unknown";
  const scaffoldMethod = getXmlAttribute(xml, "scaffold-method") ?? "unknown";
  const scaffoldCommand = getXmlAttribute(xml, "scaffold-command") ?? null;
  const installCommand = getXmlAttribute(xml, "install-command") ?? null;
  const typecheckCommand = getXmlAttribute(xml, "typecheck-command") ?? null;
  const buildCommand = getXmlAttribute(xml, "build-command") ?? null;
  const devCommand = getXmlAttribute(xml, "dev-command") ?? null;
  const requiredChecks = (getXmlAttribute(xml, "required-checks") ?? "")
    .split(",")
    .map((check) => check.trim())
    .filter(Boolean);

  const projectEvent: MissionStructuredXmlEvent = {
    eventType: created ? "project_created" : "project_creation_failed",
    summary: created
      ? `Created ${stack} project: ${name}`
      : `Project creation failed: ${name}`,
    metadata: {
      action: "create_project",
      created,
      name,
      stack,
      packageManager,
      scaffoldMethod,
      scaffoldCommand,
      installCommand,
      typecheckCommand,
      buildCommand,
      devCommand,
      requiredChecks,
    },
  };

  if (!created || requiredChecks.length === 0) {
    return [projectEvent];
  }

  return [
    projectEvent,
    {
      eventType: "post_create_verification_required",
      summary: `Post-create verification required: ${requiredChecks.join(", ")}`,
      metadata: {
        action: "create_project",
        gate: "post_create_verification",
        status: "required",
        name,
        stack,
        packageManager,
        requiredChecks,
        commands: {
          install: installCommand,
          typecheck: typecheckCommand,
          build: buildCommand,
          dev: devCommand,
        },
      },
    },
  ];
}

function getProjectVerificationEventsForXml(
  xml: string,
): MissionStructuredXmlEvent[] {
  if (!xml.startsWith("<dyad-project-verification")) {
    return [];
  }

  const events: MissionStructuredXmlEvent[] = [];
  const overallStatus = getXmlAttribute(xml, "status") ?? "unknown";
  const framework = getXmlAttribute(xml, "framework") ?? "unknown";
  const packageManager = getXmlAttribute(xml, "package-manager") ?? "unknown";

  events.push({
    eventType: "post_create_verification_run",
    summary: `Post-create verification ${overallStatus}`,
    metadata: {
      gate: "post_create_verification",
      status: overallStatus,
      framework,
      packageManager,
    },
  });

  for (const check of ["install", "typecheck", "build"] as const) {
    const status = getXmlAttribute(xml, `${check}-status`);
    const command = getXmlAttribute(xml, `${check}-command`);
    if (!status || !command) {
      continue;
    }
    const exitCodeRaw = getXmlAttribute(xml, `${check}-exit-code`);
    const exitCode = exitCodeRaw ? Number(exitCodeRaw) : null;
    events.push({
      eventType: `verification_${check}`,
      summary: `${getCheckLabel(check)} ${status}: ${command}`,
      metadata: {
        check,
        status,
        command,
        exitCode: Number.isFinite(exitCode) ? exitCode : null,
        framework,
        packageManager,
      },
    });
  }

  const runtimeStatus = getXmlAttribute(xml, "runtime-status");
  if (runtimeStatus && runtimeStatus !== "skipped") {
    events.push({
      eventType: "runtime_preview_checked",
      summary:
        runtimeStatus === "passed"
          ? `Runtime ready: ${getXmlAttribute(xml, "runtime-url") ?? "preview"}`
          : `Runtime failed: ${getXmlAttribute(xml, "runtime-error") ?? "unknown error"}`,
      metadata: {
        gate: "runtime",
        status: runtimeStatus,
        url: getXmlAttribute(xml, "runtime-url") ?? null,
        error: getXmlAttribute(xml, "runtime-error") ?? null,
        framework,
        packageManager,
      },
    });
  }

  return events;
}

function getCheckLabel(check: "install" | "typecheck" | "build") {
  if (check === "install") return "Install";
  if (check === "typecheck") return "Type check";
  return "Build";
}

function getXmlAttribute(xml: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`${escapedName}="([^"]*)"`));
  return match?.[1] ? unescapeXmlAttr(match[1]) : undefined;
}

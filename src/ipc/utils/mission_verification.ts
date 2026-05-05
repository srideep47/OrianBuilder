export type MissionVerificationEvent = {
  eventType: string;
  summary: string;
  status: "passed" | "failed";
  check: "install" | "typecheck" | "build" | "test" | "start_app";
  command?: string;
  problemCount?: number;
  exitCode?: number;
};

export function getMissionEventSummaryForXml(xml: string): string {
  const tagMatch = xml.match(/^<([a-z0-9-]+)/i);
  if (!tagMatch) {
    return "Agent output";
  }
  return `Agent output: ${tagMatch[1]}`;
}

export function getMissionVerificationEventForXml(
  xml: string,
): MissionVerificationEvent | null {
  const statusTitle = getXmlAttribute(xml, "title");
  if (
    xml.startsWith("<dyad-status") &&
    statusTitle?.startsWith("Type checking")
  ) {
    const problemCountMatch = xml.match(/Found\s+(\d+)\s+type error\(s\)/i);
    const problemCount = problemCountMatch
      ? Number(problemCountMatch[1])
      : xml.includes("No type errors found.")
        ? 0
        : undefined;
    const passed = problemCount === 0;
    return {
      eventType: "verification_typecheck",
      summary: passed
        ? "Type check passed"
        : `Type check failed${problemCount ? ` with ${problemCount} error(s)` : ""}`,
      status: passed ? "passed" : "failed",
      check: "typecheck",
      problemCount,
    };
  }

  if (!xml.startsWith("<dyad-terminal-command")) {
    return null;
  }

  const command = getXmlAttribute(xml, "cmd") ?? "terminal command";
  const exitCodeRaw = getXmlAttribute(xml, "exit-code");
  const exitCode = exitCodeRaw ? Number(exitCodeRaw) : undefined;
  if (exitCode === undefined || Number.isNaN(exitCode)) {
    return null;
  }

  const check = classifyVerificationCommand(command);
  if (!check) {
    return null;
  }

  const passed = exitCode === 0;
  const label = getVerificationLabel(check);
  return {
    eventType: `verification_${check}`,
    summary: `${label} ${passed ? "passed" : `failed with exit code ${exitCode}`}`,
    status: passed ? "passed" : "failed",
    check,
    command,
    exitCode,
  };
}

function classifyVerificationCommand(
  command: string,
): "install" | "build" | "test" | "typecheck" | "start_app" | null {
  const normalized = command.toLowerCase();
  if (
    /\b(npm|pnpm|yarn|bun)\s+(install|i)\b/.test(normalized) ||
    /\bnpm\s+ci\b/.test(normalized)
  ) {
    return "install";
  }
  if (/\b(test|vitest|jest|playwright)\b/.test(normalized)) {
    return "test";
  }
  if (/\b(build|package|make)\b/.test(normalized)) {
    return "build";
  }
  if (/\b(tsc|tsgo|typecheck|type-check|npm\s+run\s+ts)\b/.test(normalized)) {
    return "typecheck";
  }
  if (/\b(start|dev|preview)\b/.test(normalized)) {
    return "start_app";
  }
  return null;
}

function getVerificationLabel(
  check: "install" | "build" | "test" | "typecheck" | "start_app",
) {
  switch (check) {
    case "install":
      return "Install";
    case "build":
      return "Build";
    case "test":
      return "Tests";
    case "typecheck":
      return "Type check";
    case "start_app":
      return "App start";
  }
}

function getXmlAttribute(xml: string, name: string): string | undefined {
  const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(new RegExp(`${escapedName}="([^"]*)"`));
  return match?.[1];
}

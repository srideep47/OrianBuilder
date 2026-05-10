export type ParsedWorkerDiffLine = {
  type: "context" | "added" | "removed" | "meta";
  text: string;
};

export type ParsedWorkerDiffFile = {
  oldPath: string | null;
  newPath: string | null;
  displayPath: string;
  additions: number;
  deletions: number;
  lines: ParsedWorkerDiffLine[];
};

export function parseWorkerUnifiedDiff(diff: string | null | undefined) {
  if (!diff?.trim()) {
    return [];
  }

  const files: ParsedWorkerDiffFile[] = [];
  let current: ParsedWorkerDiffFile | null = null;

  for (const line of diff.split(/\r?\n/)) {
    const fileMatch = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    if (fileMatch) {
      current = {
        oldPath: fileMatch[1],
        newPath: fileMatch[2],
        displayPath: fileMatch[2] || fileMatch[1],
        additions: 0,
        deletions: 0,
        lines: [{ type: "meta", text: line }],
      };
      files.push(current);
      continue;
    }

    if (!current) {
      continue;
    }

    if (line.startsWith("+++ b/")) {
      current.newPath = line.slice("+++ b/".length);
      current.displayPath = current.newPath;
      current.lines.push({ type: "meta", text: line });
      continue;
    }

    if (line.startsWith("--- a/")) {
      current.oldPath = line.slice("--- a/".length);
      current.lines.push({ type: "meta", text: line });
      continue;
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions += 1;
      current.lines.push({ type: "added", text: line });
      continue;
    }

    if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions += 1;
      current.lines.push({ type: "removed", text: line });
      continue;
    }

    current.lines.push({
      type:
        line.startsWith("@@") || isDiffMetadataLine(line) ? "meta" : "context",
      text: line,
    });
  }

  return files;
}

function isDiffMetadataLine(line: string) {
  return (
    line.startsWith("index ") ||
    line.startsWith("new file mode ") ||
    line.startsWith("deleted file mode ") ||
    line.startsWith("similarity index ") ||
    line.startsWith("rename from ") ||
    line.startsWith("rename to ")
  );
}

import { normalizePath } from "../../../shared/normalizePath";
import { unescapeXmlAttr, unescapeXmlContent } from "../../../shared/xmlEscape";
import log from "electron-log";
import { SqlQuery } from "../../lib/schemas";

const logger = log.scope("orianbuilder_tag_parser");

export function getOrianBuilderWriteTags(fullResponse: string): {
  path: string;
  content: string;
  description?: string;
}[] {
  const orianbuilderWriteRegex =
    /<orianbuilder-write([^>]*)>([\s\S]*?)<\/orianbuilder-write>/gi;
  const pathRegex = /path="([^"]+)"/;
  const descriptionRegex = /description="([^"]+)"/;

  let match;
  const tags: { path: string; content: string; description?: string }[] = [];

  while ((match = orianbuilderWriteRegex.exec(fullResponse)) !== null) {
    const attributesString = match[1];
    let content = unescapeXmlContent(match[2].trim());

    const pathMatch = pathRegex.exec(attributesString);
    const descriptionMatch = descriptionRegex.exec(attributesString);

    if (pathMatch && pathMatch[1]) {
      const path = unescapeXmlAttr(pathMatch[1]);
      const description = descriptionMatch?.[1]
        ? unescapeXmlAttr(descriptionMatch[1])
        : undefined;

      const contentLines = content.split("\n");
      if (contentLines[0]?.startsWith("```")) {
        contentLines.shift();
      }
      if (contentLines[contentLines.length - 1]?.startsWith("```")) {
        contentLines.pop();
      }
      content = contentLines.join("\n");

      tags.push({ path: normalizePath(path), content, description });
    } else {
      logger.warn(
        "Found <orianbuilder-write> tag without a valid 'path' attribute:",
        match[0],
      );
    }
  }
  return tags;
}

export function getOrianBuilderRenameTags(fullResponse: string): {
  from: string;
  to: string;
}[] {
  const orianbuilderRenameRegex =
    /<orianbuilder-rename from="([^"]+)" to="([^"]+)"[^>]*>([\s\S]*?)<\/orianbuilder-rename>/g;
  let match;
  const tags: { from: string; to: string }[] = [];
  while ((match = orianbuilderRenameRegex.exec(fullResponse)) !== null) {
    tags.push({
      from: normalizePath(unescapeXmlAttr(match[1])),
      to: normalizePath(unescapeXmlAttr(match[2])),
    });
  }
  return tags;
}

export function getOrianBuilderCopyTags(fullResponse: string): {
  from: string;
  to: string;
  description?: string;
}[] {
  const orianbuilderCopyRegex =
    /<orianbuilder-copy([^>]*?)(?:>([\s\S]*?)<\/orianbuilder-copy>|\/>)/gi;
  const fromRegex = /from="([^"]+)"/;
  const toRegex = /to="([^"]+)"/;
  const descriptionRegex = /description="([^"]+)"/;

  let match;
  const tags: { from: string; to: string; description?: string }[] = [];

  while ((match = orianbuilderCopyRegex.exec(fullResponse)) !== null) {
    const attrs = match[1];
    const fromMatch = fromRegex.exec(attrs);
    const toMatch = toRegex.exec(attrs);
    const descriptionMatch = descriptionRegex.exec(attrs);

    if (fromMatch?.[1] && toMatch?.[1]) {
      tags.push({
        from: normalizePath(unescapeXmlAttr(fromMatch[1])),
        to: normalizePath(unescapeXmlAttr(toMatch[1])),
        description: descriptionMatch?.[1]
          ? unescapeXmlAttr(descriptionMatch[1])
          : undefined,
      });
    } else {
      logger.warn(
        "Found <orianbuilder-copy> tag without valid 'from' or 'to' attributes:",
        match[0],
      );
    }
  }
  return tags;
}

export function getOrianBuilderDeleteTags(fullResponse: string): string[] {
  const orianbuilderDeleteRegex =
    /<orianbuilder-delete path="([^"]+)"[^>]*>([\s\S]*?)<\/orianbuilder-delete>/g;
  let match;
  const paths: string[] = [];
  while ((match = orianbuilderDeleteRegex.exec(fullResponse)) !== null) {
    paths.push(normalizePath(unescapeXmlAttr(match[1])));
  }
  return paths;
}

export function getOrianBuilderAddDependencyTags(
  fullResponse: string,
): string[] {
  const orianbuilderAddDependencyRegex =
    /<orianbuilder-add-dependency packages="([^"]+)">[^<]*<\/orianbuilder-add-dependency>/g;
  let match;
  const packages: string[] = [];
  while ((match = orianbuilderAddDependencyRegex.exec(fullResponse)) !== null) {
    packages.push(...unescapeXmlAttr(match[1]).split(" "));
  }
  return packages;
}

export function getOrianBuilderChatSummaryTag(
  fullResponse: string,
): string | null {
  const orianbuilderChatSummaryRegex =
    /<orianbuilder-chat-summary>([\s\S]*?)<\/orianbuilder-chat-summary>/g;
  const match = orianbuilderChatSummaryRegex.exec(fullResponse);
  if (match && match[1]) {
    return unescapeXmlContent(match[1].trim());
  }
  return null;
}

export function getOrianBuilderExecuteSqlTags(
  fullResponse: string,
): SqlQuery[] {
  const orianbuilderExecuteSqlRegex =
    /<orianbuilder-execute-sql([^>]*)>([\s\S]*?)<\/orianbuilder-execute-sql>/g;
  const descriptionRegex = /description="([^"]+)"/;
  let match;
  const queries: { content: string; description?: string }[] = [];

  while ((match = orianbuilderExecuteSqlRegex.exec(fullResponse)) !== null) {
    const attributesString = match[1] || "";
    let content = unescapeXmlContent(match[2].trim());
    const descriptionMatch = descriptionRegex.exec(attributesString);
    const description = descriptionMatch?.[1]
      ? unescapeXmlAttr(descriptionMatch[1])
      : undefined;

    // Handle markdown code blocks if present
    const contentLines = content.split("\n");
    if (contentLines[0]?.startsWith("```")) {
      contentLines.shift();
    }
    if (contentLines[contentLines.length - 1]?.startsWith("```")) {
      contentLines.pop();
    }
    content = contentLines.join("\n");

    queries.push({ content, description });
  }

  return queries;
}

export function getOrianBuilderCommandTags(fullResponse: string): string[] {
  const orianbuilderCommandRegex =
    /<orianbuilder-command type="([^"]+)"[^>]*><\/orianbuilder-command>/g;
  let match;
  const commands: string[] = [];

  while ((match = orianbuilderCommandRegex.exec(fullResponse)) !== null) {
    commands.push(unescapeXmlAttr(match[1]));
  }

  return commands;
}

export function getOrianBuilderSearchReplaceTags(fullResponse: string): {
  path: string;
  content: string;
  description?: string;
}[] {
  const orianbuilderSearchReplaceRegex =
    /<orianbuilder-search-replace([^>]*)>([\s\S]*?)<\/orianbuilder-search-replace>/gi;
  const pathRegex = /path="([^"]+)"/;
  const descriptionRegex = /description="([^"]+)"/;

  let match;
  const tags: { path: string; content: string; description?: string }[] = [];

  while ((match = orianbuilderSearchReplaceRegex.exec(fullResponse)) !== null) {
    const attributesString = match[1] || "";
    let content = unescapeXmlContent(match[2].trim());

    const pathMatch = pathRegex.exec(attributesString);
    const descriptionMatch = descriptionRegex.exec(attributesString);

    if (pathMatch && pathMatch[1]) {
      const path = unescapeXmlAttr(pathMatch[1]);
      const description = descriptionMatch?.[1]
        ? unescapeXmlAttr(descriptionMatch[1])
        : undefined;

      // Handle markdown code fences if present
      const contentLines = content.split("\n");
      if (contentLines[0]?.startsWith("```")) {
        contentLines.shift();
      }
      if (contentLines[contentLines.length - 1]?.startsWith("```")) {
        contentLines.pop();
      }
      content = contentLines.join("\n");

      tags.push({ path: normalizePath(path), content, description });
    } else {
      logger.warn(
        "Found <orianbuilder-search-replace> tag without a valid 'path' attribute:",
        match[0],
      );
    }
  }
  return tags;
}

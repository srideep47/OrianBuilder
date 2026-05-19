/**
 * Helpers for assembling the final ModelMessage handed to the AI SDK.
 *
 * - replaceTextAttachmentWithContent: inlines text-file attachments by replacing
 *   their <orianbuilder-text-attachment> placeholder tags with the actual content.
 * - prepareMessageWithAttachments: converts a plain-text user message into a
 *   content-parts array (text + images), reading image files and base64-encoding
 *   them for proper JSON serialization in aiMessagesJson.
 */

import { ModelMessage, TextPart, ImagePart } from "ai";
import * as path from "path";
import { readFile } from "fs/promises";
import log from "electron-log";

import { escapeXmlAttr } from "../../../../shared/xmlEscape";
import { isTextFile } from "./chat_text_utils";

const logger = log.scope("chat_stream_handlers");

export async function replaceTextAttachmentWithContent(
  text: string,
  filePath: string,
  fileName: string,
): Promise<string> {
  try {
    if (await isTextFile(filePath)) {
      const fullContent = await readFile(filePath, "utf-8");
      // The path attribute in the tag is XML-escaped (via escapeXmlAttr), so we
      // must also XML-escape the path before regex-escaping to ensure a match.
      const xmlEscapedPath = escapeXmlAttr(filePath);
      const escapedPath = xmlEscapedPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const tagPattern = new RegExp(
        `<orianbuilder-text-attachment filename="[^"]*" type="[^"]*" path="${escapedPath}">\\s*<\\/orianbuilder-text-attachment>`,
        "g",
      );

      const replacedText = text.replace(
        tagPattern,
        `Full content of ${fileName}:\n\`\`\`\n${fullContent}\n\`\`\``,
      );

      logger.log(
        `Replaced text attachment content for: ${fileName} - length before: ${text.length} - length after: ${replacedText.length}`,
      );
      return replacedText;
    }
    return text;
  } catch (error) {
    logger.error(`Error processing text file: ${error}`);
    return text;
  }
}

export async function prepareMessageWithAttachments(
  message: ModelMessage,
  attachmentPaths: string[],
): Promise<ModelMessage> {
  let textContent = message.content;
  if (typeof textContent !== "string") {
    logger.warn(
      "Message content is not a string - shouldn't happen but using message as-is",
    );
    return message;
  }

  for (const filePath of attachmentPaths) {
    const fileName = path.basename(filePath);
    textContent = await replaceTextAttachmentWithContent(
      textContent,
      filePath,
      fileName,
    );
  }

  const contentParts: (TextPart | ImagePart)[] = [];

  contentParts.push({
    type: "text",
    text: textContent,
  });

  for (const filePath of attachmentPaths) {
    const ext = path.extname(filePath).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".gif", ".webp"].includes(ext)) {
      try {
        // Use base64 strings instead of raw Buffers — raw Buffers serialize
        // inefficiently and exceed the size limit for aiMessagesJson.
        const imageBuffer = await readFile(filePath);
        const mimeType =
          ext === ".jpg" ? "image/jpeg" : `image/${ext.slice(1)}`;
        const base64Data = imageBuffer.toString("base64");

        contentParts.push({
          type: "image",
          image: base64Data,
          mediaType: mimeType,
        });

        logger.log(`Added image attachment: ${filePath}`);
      } catch (error) {
        logger.error(`Error reading image file: ${error}`);
      }
    }
  }

  return {
    role: "user",
    content: contentParts,
  };
}

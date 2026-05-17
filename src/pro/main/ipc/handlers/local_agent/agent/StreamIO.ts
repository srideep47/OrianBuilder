/**
 * Streaming I/O helpers for the local-agent streaming loop.
 * Pure utilities — no business logic, just DB write + IPC chunk dispatch.
 */

import type { IpcMainInvokeEvent } from "electron";
import log from "electron-log";

import { db } from "@/db";
import { messages } from "@/db/schema";
import { eq } from "drizzle-orm";
import { safeSend } from "@/ipc/utils/safe_sender";

const logger = log.scope("local_agent_handler");

export async function updateResponseInDb(
  messageId: number,
  content: string,
): Promise<void> {
  await db
    .update(messages)
    .set({ content })
    .where(eq(messages.id, messageId))
    .catch((err) => logger.error("Failed to update message", err));
}

export function sendResponseChunk(
  event: IpcMainInvokeEvent,
  chatId: number,
  chat: { messages: Array<{ id: number; content: string }> },
  fullResponse: string,
  placeholderMessageId: number,
  hiddenMessageIds?: Set<number>,
  /** When true, sends the full messages array instead of an incremental update */
  sendFullMessages?: boolean,
): void {
  if (sendFullMessages) {
    const currentMessages = [...chat.messages].filter(
      (message) => !hiddenMessageIds?.has(message.id),
    );
    const placeholderMsg = currentMessages.find(
      (m) => m.id === placeholderMessageId,
    );
    if (placeholderMsg) {
      placeholderMsg.content = fullResponse;
    }
    safeSend(event.sender, "chat:response:chunk", {
      chatId,
      messages: currentMessages,
    });
  } else {
    safeSend(event.sender, "chat:response:chunk", {
      chatId,
      streamingMessageId: placeholderMessageId,
      streamingContent: fullResponse,
    });
  }
}

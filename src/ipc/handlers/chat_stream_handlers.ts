/**
 * Thin re-export barrel for the chat streaming IPC handler. The actual
 * implementation lives in `./chat/*` — see `chat_stream_setup.ts` for the
 * `registerChatStreamHandlers` entry point and `chat_text_utils.ts` for the
 * text/tag utilities consumed by tests.
 */

export { registerChatStreamHandlers } from "./chat/chat_stream_setup";
export {
  formatMessagesForSummary,
  hasUnclosedOrianBuilderWrite,
  removeOrianBuilderTags,
  removeProblemReportTags,
} from "./chat/chat_text_utils";

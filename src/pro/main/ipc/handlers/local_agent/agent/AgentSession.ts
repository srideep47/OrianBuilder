import type { ModelMessage } from "ai";

import { getPostCompactionMessages } from "@/ipc/handlers/compaction/compaction_utils";
import {
  parseAiMessagesJson,
  type DbMessageForParsing,
} from "@/ipc/utils/ai_messages_utils";
import { filterCancelledMessagePairs } from "@/shared/chatCancellation";

import {
  buildNativeTargetReminder,
  type NativeTargetIntent,
} from "../native_target_intent";

export function buildChatMessageHistory(
  chatMessages: Array<
    DbMessageForParsing & {
      isCompactionSummary: boolean | null;
      createdAt: Date;
    }
  >,
  options?: { excludeMessageIds?: Set<number> },
): ModelMessage[] {
  const excludedIds = options?.excludeMessageIds;
  const relevantMessages = getPostCompactionMessages(chatMessages);
  const reorderedMessages = [...relevantMessages];

  // For mid-turn compaction, keep the summary immediately after the triggering
  // user message so subsequent turns reflect that compaction happened before
  // post-compaction tool-loop steps.
  for (const summary of [...reorderedMessages].filter(
    (message) => message.isCompactionSummary,
  )) {
    const summaryIndex = reorderedMessages.findIndex(
      (m) => m.id === summary.id,
    );
    if (summaryIndex < 0) {
      continue;
    }

    const triggeringUser = [...reorderedMessages]
      .filter((m) => m.role === "user" && m.id < summary.id)
      .sort((a, b) => b.id - a.id)[0];
    if (!triggeringUser) {
      continue;
    }

    const triggeringUserIndex = reorderedMessages.findIndex(
      (m) => m.id === triggeringUser.id,
    );
    if (triggeringUserIndex < 0) {
      continue;
    }

    const isMidTurnSummary =
      summary.createdAt.getTime() >= triggeringUser.createdAt.getTime();
    if (!isMidTurnSummary || summaryIndex === triggeringUserIndex + 1) {
      continue;
    }

    reorderedMessages.splice(summaryIndex, 1);
    const targetIndex = Math.min(
      triggeringUserIndex + 1,
      reorderedMessages.length,
    );
    reorderedMessages.splice(targetIndex, 0, summary);
  }

  const filtered = reorderedMessages
    .filter((msg) => !excludedIds?.has(msg.id))
    .filter((msg) => msg.content || msg.aiMessagesJson);

  // Filter out cancelled message pairs (user prompt + cancelled assistant response)
  // so the AI doesn't try to reconcile cancelled/incorrect prompts with new ones.
  return filterCancelledMessagePairs(filtered).flatMap((msg) =>
    parseAiMessagesJson(msg),
  );
}

/**
 * Append a `<system-reminder>` to the latest user message listing referenced
 * apps so the agent knows which `app_name` values it can pass to read-only
 * tools (`read_file`, `list_files`, `grep`, `code_search`). Mutates the last
 * user message in-place to avoid copying unrelated parts of the history.
 */
export function injectReferencedAppsReminder(
  messageHistory: ModelMessage[],
  referencedApps: readonly { appName: string }[],
): void {
  const list = referencedApps.map(({ appName }) => `\`${appName}\``).join(", ");
  const reminder = `\n\n<system-reminder>\nThe user has mentioned the following apps in their prompt: ${list}. These apps are separate from the current app and are READ-ONLY. To inspect them, pass the app name as the \`app_name\` parameter to read-only tools (\`read_file\`, \`list_files\`, \`grep\`, \`code_search\`); matching is case-insensitive. Write tools cannot target these apps. Omit \`app_name\` to operate on the current app.\n</system-reminder>`;

  for (let i = messageHistory.length - 1; i >= 0; i--) {
    const msg = messageHistory[i];
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") {
      messageHistory[i] = { ...msg, content: msg.content + reminder };
    } else {
      messageHistory[i] = {
        ...msg,
        content: [...msg.content, { type: "text", text: reminder }],
      };
    }
    return;
  }
}

export function injectUserMessageReminder(
  messageHistory: ModelMessage[],
  reminder: string,
): void {
  for (let i = messageHistory.length - 1; i >= 0; i--) {
    const msg = messageHistory[i];
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") {
      messageHistory[i] = { ...msg, content: `${msg.content}\n\n${reminder}` };
    } else {
      messageHistory[i] = {
        ...msg,
        content: [...msg.content, { type: "text", text: `\n\n${reminder}` }],
      };
    }
    return;
  }
}

export function hasCompletedNativePackage(response: string): boolean {
  return /<orianbuilder-native-package\b[^>]*status="passed"/.test(response);
}

export function buildNativeTargetFollowUpMessage(
  intent: NativeTargetIntent,
  options: {
    userPrompt: string | null;
    appIndexEdited: boolean;
    createdProjectThisTurn: boolean;
  },
): ModelMessage {
  const reminder = buildNativeTargetReminder(intent);

  // Most common failure with weak local models: they call create_project,
  // emit a todo to "implement the UI", and then stop. Auto-finish then ships
  // the baseline counter app as the APK — pipeline succeeds but the user's
  // actual request (e.g., "show numbers 1 to 13") is ignored. Detect this
  // and push a targeted directive that names the file + the user's request.
  if (options.createdProjectThisTurn && !options.appIndexEdited) {
    const userRequestLine = options.userPrompt
      ? `The user asked for: "${options.userPrompt.slice(0, 400).trim()}".`
      : "";
    return {
      role: "user",
      content: [
        {
          type: "text",
          text:
            `${reminder}\n\n` +
            `You scaffolded the Expo project but never edited app/index.tsx — the build will ship the generic counter baseline instead of the requested UI. ` +
            `${userRequestLine} ` +
            `Your VERY NEXT tool call MUST be write_file({path: "app/index.tsx", content: "<the implementation>"}) using React Native components (View, Text, ScrollView, StyleSheet) to render exactly what the user asked for. ` +
            `Then run browser_qa_gate, then package_native_artifact(target="${intent.target}"). ` +
            `Do not call package_native_artifact before writing app/index.tsx — the resulting APK would not contain the user's UI.`,
        },
      ],
    };
  }

  return {
    role: "user",
    content: [
      {
        type: "text",
        text: `${reminder}\n\nYou have not completed the required native packaging artifact yet. Continue now. Do not stop after web UI work; run project checks and package_native_artifact with target="${intent.target}".`,
      },
    ],
  };
}

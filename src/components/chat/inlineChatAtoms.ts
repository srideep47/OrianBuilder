import { atom } from "jotai";

export interface InlineChatMessage {
  id: number;
  role: "user" | "assistant";
  content: string;
}

export interface InlineChatHistoryEntry {
  id: string;
  title: string;
  messages: InlineChatMessage[];
  createdAt: string; // ISO 8601
}

// Defined in a stable module (not a component) so HMR never recreates the
// atom instances, keeping ChatPanel and ChatList in sync at all times.
export const inlineChatHistoryAtom = atom<InlineChatHistoryEntry[]>([]);
export const currentInlineChatIdAtom = atom<string | null>(null);

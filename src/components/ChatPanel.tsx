import { useState, useRef, useEffect, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useAtomValue, useSetAtom } from "jotai";
import {
  chatErrorByIdAtom,
  chatMessagesByIdAtom,
  chatStreamCountByIdAtom,
  isStreamingByIdAtom,
} from "../atoms/chatAtoms";
import { ipc } from "@/ipc/types";

import { ChatHeader } from "./chat/ChatHeader";
import { MessagesList } from "./chat/MessagesList";
import { ChatInput } from "./chat/ChatInput";
import { VersionPane } from "./chat/VersionPane";
import { FreeAgentQuotaBanner } from "./chat/FreeAgentQuotaBanner";
import { NotificationBanner } from "./chat/NotificationBanner";
import { MissionControl } from "./chat/MissionControl";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
} from "@/components/ui/tooltip";
import { ArrowDown } from "lucide-react";
import { useSettings } from "@/hooks/useSettings";
import { useFreeAgentQuota } from "@/hooks/useFreeAgentQuota";
import { useChatMode } from "@/hooks/useChatMode";
import { isOrianBuilderProEnabled } from "@/lib/schemas";
import { streamChatResponse } from "@/lib/chatStream";

import {
  inlineChatHistoryAtom,
  currentInlineChatIdAtom,
  type InlineChatMessage,
} from "./chat/inlineChatAtoms";

interface ChatPanelProps {
  chatId?: number;
  isPreviewOpen: boolean;
  onTogglePreview: () => void;
}

export function ChatPanel({
  chatId,
  isPreviewOpen,
  onTogglePreview,
}: ChatPanelProps) {
  const { t } = useTranslation("chat");
  const messagesById = useAtomValue(chatMessagesByIdAtom);
  const chatErrorById = useAtomValue(chatErrorByIdAtom);
  const setMessagesById = useSetAtom(chatMessagesByIdAtom);
  const [isVersionPaneOpen, setIsVersionPaneOpen] = useState(false);
  const streamCountById = useAtomValue(chatStreamCountByIdAtom);
  const isStreamingById = useAtomValue(isStreamingByIdAtom);
  const { settings } = useSettings();
  const { selectedMode, setChatMode } = useChatMode(chatId);
  const { isQuotaExceeded } = useFreeAgentQuota();
  const showFreeAgentQuotaBanner =
    settings &&
    !isOrianBuilderProEnabled(settings) &&
    selectedMode === "local-agent" &&
    isQuotaExceeded;

  // ── No-app inline chat (used when chatId is undefined) ──────────────────────
  const [inlineMessages, setInlineMessages] = useState<InlineChatMessage[]>([]);
  const [isInlineReplying, setIsInlineReplying] = useState(false);
  const inlineBufferRef = useRef("");
  const inlineFlushTimerRef = useRef<number | null>(null);
  const inlineIdCounterRef = useRef(0);
  const inlineMessagesEndRef = useRef<HTMLDivElement | null>(null);

  // ── Inline chat history ────────────────────────────────────────────────────
  const setInlineChatHistory = useSetAtom(inlineChatHistoryAtom);
  const setCurrentInlineChatId = useSetAtom(currentInlineChatIdAtom);
  const currentInlineChatId = useAtomValue(currentInlineChatIdAtom);

  // Ref so callbacks always see the latest chat id without stale closures.
  const currentInlineChatIdRef = useRef(currentInlineChatId);
  useEffect(() => {
    currentInlineChatIdRef.current = currentInlineChatId;
  });

  // When the sidebar switches the active chat, load that chat's messages.
  const prevInlineChatIdRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (prevInlineChatIdRef.current === currentInlineChatId) return;
    prevInlineChatIdRef.current = currentInlineChatId;
    if (currentInlineChatId === null) {
      setInlineMessages([]);
      return;
    }
    // Restore messages from history — only when the entry already has content
    // (avoids wiping messages that handleNoAppSubmit just added to a new entry).
    setInlineChatHistory((prev) => {
      const entry = prev.find((e) => e.id === currentInlineChatId);
      if (entry && entry.messages.length > 0) setInlineMessages(entry.messages);
      return prev;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentInlineChatId]);

  // Keep the active history entry up to date as messages arrive.
  useEffect(() => {
    const chatId = currentInlineChatIdRef.current;
    if (!chatId || inlineMessages.length === 0) return;
    setInlineChatHistory((prev) =>
      prev.map((e) =>
        e.id === chatId ? { ...e, messages: inlineMessages } : e,
      ),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [inlineMessages]);
  // ──────────────────────────────────────────────────────────────────────────

  useEffect(() => {
    inlineMessagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [inlineMessages]);

  useEffect(() => {
    return () => {
      if (inlineFlushTimerRef.current)
        window.clearInterval(inlineFlushTimerRef.current);
    };
  }, []);

  const handleNoAppSubmit = useCallback(
    (text: string) => {
      if (!text.trim() || isInlineReplying) return;

      // Create a history entry the first time a message is sent in a new session.
      if (!currentInlineChatIdRef.current) {
        const newId = crypto.randomUUID();
        setInlineChatHistory((prev) => [
          {
            id: newId,
            title: text.length > 60 ? text.slice(0, 60) + "…" : text,
            messages: [],
            createdAt: new Date().toISOString(),
          },
          ...prev,
        ]);
        setCurrentInlineChatId(newId);
        currentInlineChatIdRef.current = newId;
      }

      const userId = --inlineIdCounterRef.current;
      const assistantId = --inlineIdCounterRef.current;

      const apiMessages = [
        {
          role: "system",
          content:
            "You are OrianBuilder Assistant, a helpful AI. Answer questions clearly and concisely.",
        },
        ...inlineMessages.map((m) => ({ role: m.role, content: m.content })),
        { role: "user", content: text },
      ];

      setInlineMessages((prev) => [
        ...prev,
        { id: userId, role: "user", content: text },
        { id: assistantId, role: "assistant", content: "" },
      ]);
      setIsInlineReplying(true);
      inlineBufferRef.current = "";

      if (inlineFlushTimerRef.current) {
        window.clearInterval(inlineFlushTimerRef.current);
        inlineFlushTimerRef.current = null;
      }

      const openRouterKey =
        settings?.providerSettings?.openrouter?.apiKey?.value;

      const commitAssistant = (content: string) => {
        setInlineMessages((prev) =>
          prev.map((m) => (m.id === assistantId ? { ...m, content } : m)),
        );
        setIsInlineReplying(false);
        if (inlineFlushTimerRef.current) {
          window.clearInterval(inlineFlushTimerRef.current);
          inlineFlushTimerRef.current = null;
        }
      };

      streamChatResponse(apiMessages, openRouterKey, {
        onChunk: (delta) => {
          inlineBufferRef.current += delta;
        },
        onEnd: () => commitAssistant(inlineBufferRef.current),
        onError: (msg) => commitAssistant(`⚠️ ${msg}`),
      });

      inlineFlushTimerRef.current = window.setInterval(() => {
        const buf = inlineBufferRef.current;
        setInlineMessages((prev) => {
          const last = prev.at(-1);
          if (last?.id === assistantId && last.content !== buf) {
            return prev.map((m) =>
              m.id === assistantId ? { ...m, content: buf } : m,
            );
          }
          return prev;
        });
      }, 80);
    },
    [
      inlineMessages,
      isInlineReplying,
      settings,
      setInlineChatHistory,
      setCurrentInlineChatId,
    ],
  );
  // ─────────────────────────────────────────────────────────────────────────────

  const messagesEndRef = useRef<HTMLDivElement | null>(null);
  const messagesContainerRef = useRef<HTMLDivElement | null>(null);

  // Tracks whether the user is at the bottom of the scroll container.
  // Uses a ref so followOutput can read it without stale closures,
  // and state for the scroll button UI which needs re-renders.
  const isAtBottomRef = useRef(true);
  const [showScrollButton, setShowScrollButton] = useState(false);
  // Ref to track previous streaming state for stream-complete scroll
  const prevIsStreamingRef = useRef(false);

  const scrollToBottom = useCallback((behavior: ScrollBehavior = "smooth") => {
    messagesEndRef.current?.scrollIntoView({ behavior });
  }, []);

  // Called by Virtuoso's atBottomStateChange (production) or scroll handler (test mode).
  // Pure position-based: no timeouts, no debounce.
  const handleAtBottomChange = useCallback((atBottom: boolean) => {
    isAtBottomRef.current = atBottom;
    setShowScrollButton(!atBottom);
  }, []);

  const handleScrollButtonClick = useCallback(() => {
    // Optimistically mark as at-bottom so followOutput resumes immediately
    isAtBottomRef.current = true;
    setShowScrollButton(false);
    scrollToBottom("smooth");
  }, [scrollToBottom]);

  // Scroll to bottom when a new stream starts (user sent a message)
  const streamCount = chatId ? (streamCountById.get(chatId) ?? 0) : 0;
  const messages = chatId ? (messagesById.get(chatId) ?? []) : [];
  const streamError = chatId ? (chatErrorById.get(chatId) ?? null) : null;

  // Track previous chatId to detect chat switches
  const prevChatIdRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    const isChatSwitch = prevChatIdRef.current !== chatId;
    prevChatIdRef.current = chatId;

    isAtBottomRef.current = true;
    setShowScrollButton(false);

    if (isChatSwitch && messages.length > 0) {
      // When switching chats with existing messages, wait for Virtuoso to render
      // then scroll to ensure we're at the bottom
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToBottom("instant");
        });
      });
    } else if (!isChatSwitch) {
      // For stream count changes (new message sent), wait for Virtuoso to render
      // the placeholder message before scrolling
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToBottom();
        });
      });
    }
    // Note: if isChatSwitch && messages.length === 0, we don't scroll yet.
    // The messages will be fetched and this effect will re-run with messages.length > 0.
  }, [chatId, streamCount, messages.length, scrollToBottom]);

  const fetchChatMessages = useCallback(async () => {
    if (!chatId) {
      // no-op when no chat
      return;
    }
    const chat = await ipc.chat.getChat(chatId);
    setMessagesById((prev) => {
      const next = new Map(prev);
      next.set(chatId, chat.messages);
      return next;
    });
  }, [chatId, setMessagesById]);

  useEffect(() => {
    fetchChatMessages();
  }, [fetchChatMessages]);

  const isStreaming = chatId ? (isStreamingById.get(chatId) ?? false) : false;

  // Scroll to bottom when streaming completes to ensure footer content is visible,
  // but only if the user was following (at bottom) during the stream.
  useEffect(() => {
    const wasStreaming = prevIsStreamingRef.current;
    prevIsStreamingRef.current = isStreaming;

    if (wasStreaming && !isStreaming && isAtBottomRef.current) {
      // Double RAF ensures DOM is fully updated with footer content
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          scrollToBottom("smooth");
        });
      });
    }
  }, [isStreaming, scrollToBottom]);

  // Keep footer actions (including Retry) visible when stream errors render below.
  useEffect(() => {
    if (!streamError) return;

    const container = messagesContainerRef.current;
    const distanceFromBottom = container
      ? container.scrollHeight - (container.scrollTop + container.clientHeight)
      : 0;
    const isNearBottom = distanceFromBottom <= 220;
    if (!isAtBottomRef.current && !isNearBottom) return;

    let cancelled = false;
    let firstRafId: number | undefined;
    let secondRafId: number | undefined;
    let timeoutId: number | undefined;

    firstRafId = requestAnimationFrame(() => {
      if (cancelled) return;
      secondRafId = requestAnimationFrame(() => {
        if (cancelled) return;
        scrollToBottom("instant");
        timeoutId = window.setTimeout(() => {
          if (!cancelled) {
            scrollToBottom("smooth");
          }
        }, 120);
      });
    });

    return () => {
      cancelled = true;
      if (firstRafId !== undefined) {
        window.cancelAnimationFrame(firstRafId);
      }
      if (secondRafId !== undefined) {
        window.cancelAnimationFrame(secondRafId);
      }
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
      }
    };
  }, [streamError, scrollToBottom]);

  // Test mode only: Track scroll position to update isAtBottom state.
  // In production, Virtuoso's atBottomStateChange handles this.
  useEffect(() => {
    if (!settings?.isTestMode) return;

    const container = messagesContainerRef.current;
    if (!container) return;

    const handleScroll = () => {
      const distanceFromBottom =
        container.scrollHeight - (container.scrollTop + container.clientHeight);
      handleAtBottomChange(distanceFromBottom <= 80);
    };

    container.addEventListener("scroll", handleScroll, { passive: true });
    return () => container.removeEventListener("scroll", handleScroll);
  }, [settings?.isTestMode, isVersionPaneOpen, handleAtBottomChange]);

  // Test mode: Auto-scroll during streaming when user is at the bottom.
  // In production, Virtuoso's followOutput handles this.
  useEffect(() => {
    if (!settings?.isTestMode) return;

    if (isAtBottomRef.current && isStreaming) {
      requestAnimationFrame(() => {
        scrollToBottom("instant");
      });
    }
  }, [messages, isStreaming, settings?.isTestMode, scrollToBottom]);

  return (
    <div className="flex flex-col h-full">
      <ChatHeader
        isVersionPaneOpen={isVersionPaneOpen}
        isPreviewOpen={isPreviewOpen}
        onTogglePreview={onTogglePreview}
        onVersionClick={() => setIsVersionPaneOpen(!isVersionPaneOpen)}
      />
      <div className="flex flex-1 overflow-hidden">
        {!isVersionPaneOpen && (
          <div className="flex-1 flex flex-col min-w-0">
            <div className="flex-1 relative overflow-hidden">
              {chatId !== undefined ? (
                <>
                  <MessagesList
                    messages={messages}
                    messagesEndRef={messagesEndRef}
                    ref={messagesContainerRef}
                    onAtBottomChange={handleAtBottomChange}
                  />
                  {showScrollButton && (
                    <div className="absolute bottom-6 left-1/2 -translate-x-1/2 z-10">
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <Button
                              onClick={handleScrollButtonClick}
                              size="icon"
                              className="rounded-full shadow-lg hover:shadow-xl transition-all border border-border/50 backdrop-blur-sm bg-background/95 hover:bg-accent"
                              variant="outline"
                            />
                          }
                        >
                          <ArrowDown className="h-4 w-4" />
                        </TooltipTrigger>
                        <TooltipContent>{t("scrollToBottom")}</TooltipContent>
                      </Tooltip>
                    </div>
                  )}
                </>
              ) : (
                /* No app selected — home-page-style inline chat feed */
                <div className="absolute inset-0 overflow-y-auto">
                  <div className="w-full max-w-3xl mx-auto px-4 py-6 flex flex-col gap-4 h-full">
                    {inlineMessages.length === 0 ? (
                      <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
                        Start the conversation — type a message below
                      </div>
                    ) : (
                      inlineMessages.map((msg, i) =>
                        msg.role === "user" ? (
                          <div key={msg.id} className="flex justify-end">
                            <div className="bg-primary/15 border border-primary/25 text-white rounded-2xl px-4 py-2.5 max-w-[72%] text-sm whitespace-pre-wrap">
                              {msg.content}
                            </div>
                          </div>
                        ) : (
                          <div key={msg.id} className="flex gap-3 items-start">
                            <div className="w-7 h-7 rounded-full bg-primary/20 border border-primary/30 flex items-center justify-center flex-shrink-0 mt-0.5 text-xs text-primary font-bold select-none">
                              O
                            </div>
                            <div className="bg-white/[0.04] border border-white/10 text-white/85 rounded-2xl px-4 py-3 max-w-[72%] text-sm leading-relaxed whitespace-pre-wrap min-h-[2.5rem]">
                              {msg.content ||
                                (isInlineReplying &&
                                i === inlineMessages.length - 1 ? (
                                  <span className="flex gap-1 items-center h-5">
                                    <span className="w-1.5 h-1.5 rounded-full bg-white/50 animate-bounce [animation-delay:0ms]" />
                                    <span className="w-1.5 h-1.5 rounded-full bg-white/50 animate-bounce [animation-delay:150ms]" />
                                    <span className="w-1.5 h-1.5 rounded-full bg-white/50 animate-bounce [animation-delay:300ms]" />
                                  </span>
                                ) : null)}
                            </div>
                          </div>
                        ),
                      )
                    )}
                    <div ref={inlineMessagesEndRef} />
                  </div>
                </div>
              )}
            </div>
            {showFreeAgentQuotaBanner && (
              <FreeAgentQuotaBanner
                onSwitchToBuildMode={() =>
                  void setChatMode("build").catch(() => {})
                }
              />
            )}
            <div className="px-2 mb-3">
              <div className="max-w-3xl mx-auto w-full">
                <MissionControl chatId={chatId} />
                <NotificationBanner />
              </div>
            </div>
            <ChatInput chatId={chatId} onNoAppSubmit={handleNoAppSubmit} />
          </div>
        )}
        <VersionPane
          isVisible={isVersionPaneOpen}
          onClose={() => setIsVersionPaneOpen(false)}
        />
      </div>
    </div>
  );
}

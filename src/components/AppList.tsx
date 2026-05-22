import { useNavigate } from "@tanstack/react-router";
import { PlusCircle, Search, MoreVertical, Trash2, Edit3 } from "lucide-react";
import { useAtom, useSetAtom } from "jotai";
import { pdfPreviewDataAtom } from "@/lib/pdfGenerator";
import { isPreviewOpenAtom } from "@/atoms/viewAtoms";
import {
  selectedChatIdAtom,
  homeChatMessagesAtom,
  homeChatHistoryAtom,
  currentHomePdfTopicAtom,
  type HomeChatHistoryEntry,
} from "@/atoms/chatAtoms";
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
} from "@/components/ui/sidebar";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useChats } from "@/hooks/useChats";
import { useSelectChat } from "@/hooks/useSelectChat";
import { ipc } from "@/ipc/types";
import { useState, useMemo, useCallback } from "react";
import { formatDistanceToNow } from "date-fns";
import { ChatSearchDialog } from "./ChatSearchDialog";

export function AppList({ show }: { show?: boolean }) {
  const navigate = useNavigate();
  const [selectedChatId] = useAtom(selectedChatIdAtom);
  const [homeChatMessages, setHomeChatMessages] = useAtom(homeChatMessagesAtom);
  const [homeChatHistory, setHomeChatHistory] = useAtom(homeChatHistoryAtom);
  const [currentPdfTopic] = useAtom(currentHomePdfTopicAtom);
  const setPdfPreviewData = useSetAtom(pdfPreviewDataAtom);
  const setIsPreviewOpen = useSetAtom(isPreviewOpenAtom);
  const { chats, loading, invalidateChats } = useChats(null);
  const { selectChat } = useSelectChat();
  const [isSearchDialogOpen, setIsSearchDialogOpen] = useState(false);
  const [renamingId, setRenamingId] = useState<string | "current" | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const inlineChatTitle =
    homeChatMessages.find((m) => m.role === "user")?.content?.slice(0, 60) ??
    currentPdfTopic ??
    null;

  // Combine in-memory history + DB chats for the search dialog
  // Must be before early return to satisfy Rules of Hooks
  const allChatsForSearch = useMemo(
    () => [
      ...homeChatHistory.map((e, i) => ({
        id: -(i + 1),
        appId: 0,
        title: e.title,
        createdAt: new Date(e.createdAt),
        chatMode: null as null,
      })),
      ...chats,
    ],
    [homeChatHistory, chats],
  );

  if (!show) {
    return null;
  }

  const handleNewApp = () => {
    if (homeChatMessages.length > 0) {
      const title =
        homeChatMessages
          .find((m) => m.role === "user")
          ?.content?.slice(0, 60) ?? "Chat";
      const entry: HomeChatHistoryEntry = {
        id: crypto.randomUUID(),
        title,
        messages: [...homeChatMessages],
        createdAt: new Date().toISOString(),
      };
      setHomeChatHistory((prev) => [entry, ...prev]);
    }
    setHomeChatMessages([]);
    navigate({ to: "/" });
  };

  const handleHistoryClick = (entry: HomeChatHistoryEntry) => {
    if (entry.pdfData) {
      setPdfPreviewData(entry.pdfData);
      setIsPreviewOpen(true);
      navigate({ to: "/chat" });
    } else {
      setHomeChatMessages(entry.messages);
      setHomeChatHistory((prev) => prev.filter((e) => e.id !== entry.id));
      navigate({ to: "/" });
    }
  };

  const startRename = (id: string | "current", currentTitle: string) => {
    setRenamingId(id);
    setRenameValue(currentTitle);
  };

  const commitRename = () => {
    if (!renamingId || !renameValue.trim()) {
      setRenamingId(null);
      return;
    }
    if (renamingId === "current") {
      const entry: HomeChatHistoryEntry = {
        id: crypto.randomUUID(),
        title: renameValue.trim(),
        messages: [...homeChatMessages],
        createdAt: new Date().toISOString(),
      };
      setHomeChatHistory((prev) => [entry, ...prev]);
      setHomeChatMessages([]);
    } else {
      setHomeChatHistory((prev) =>
        prev.map((e) =>
          e.id === renamingId ? { ...e, title: renameValue.trim() } : e,
        ),
      );
    }
    setRenamingId(null);
  };

  const handleSearchSelect = useCallback(
    ({ chatId, appId }: { chatId: number; appId: number }) => {
      setIsSearchDialogOpen(false);
      if (chatId < 0) {
        const idx = -(chatId + 1);
        const entry = homeChatHistory[idx];
        if (!entry) return;
        if (entry.pdfData) {
          setPdfPreviewData(entry.pdfData);
          setIsPreviewOpen(true);
          navigate({ to: "/chat" });
        } else {
          setHomeChatMessages(entry.messages);
          setHomeChatHistory((prev) => prev.filter((e) => e.id !== entry.id));
          navigate({ to: "/" });
        }
      } else {
        selectChat({ chatId, appId });
      }
    },
    [
      homeChatHistory,
      selectChat,
      navigate,
      setPdfPreviewData,
      setIsPreviewOpen,
      setHomeChatMessages,
      setHomeChatHistory,
    ],
  );

  const handleChatClick = ({
    chatId,
    appId,
  }: {
    chatId: number;
    appId: number;
  }) => {
    selectChat({ chatId, appId });
    setIsSearchDialogOpen(false);
  };

  const handleDeleteDbChat = async (chatId: number) => {
    await ipc.chat.deleteChat(chatId);
    await invalidateChats();
  };

  const handleRenameDbChat = async (chatId: number, title: string) => {
    if (!title.trim()) return;
    await ipc.chat.updateChat({ chatId, title: title.trim() });
    await invalidateChats();
  };

  const hasHistory =
    inlineChatTitle || homeChatHistory.length > 0 || chats.length > 0;

  return (
    <>
      <SidebarGroup className="" data-testid="app-list-container">
        <SidebarGroupLabel>Your Apps</SidebarGroupLabel>
        <SidebarGroupContent>
          <div className="flex flex-col space-y-2">
            <Button
              onClick={handleNewApp}
              variant="outline"
              className="flex items-center justify-start gap-2 mx-2 py-2"
            >
              <PlusCircle size={16} />
              <span>New App</span>
            </Button>
            <Button
              onClick={() => setIsSearchDialogOpen(!isSearchDialogOpen)}
              variant="outline"
              className="flex items-center justify-start gap-2 mx-2 py-3"
              data-testid="search-apps-button"
            >
              <Search size={16} />
              <span>Search Apps</span>
            </Button>

            {loading ? (
              <div className="py-2 px-4 text-sm text-gray-500">Loading...</div>
            ) : !hasHistory ? (
              <div className="py-2 px-4 text-sm text-gray-500">
                No history found
              </div>
            ) : (
              <SidebarMenu className="space-y-1 px-2" data-testid="app-list">
                {inlineChatTitle && (
                  <SidebarMenuItem className="mb-1">
                    <div className="flex w-full items-center">
                      {renamingId === "current" ? (
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          className="flex-1 bg-transparent border-b border-primary text-sm px-2 py-1 outline-none"
                        />
                      ) : (
                        <Button
                          variant="ghost"
                          onClick={() => navigate({ to: "/" })}
                          className="justify-start flex-1 text-left py-3 pr-1 hover:bg-sidebar-accent/80 bg-sidebar-accent text-sidebar-accent-foreground"
                        >
                          <div className="flex flex-col w-full">
                            <span className="truncate">{inlineChatTitle}</span>
                            <span className="text-xs text-gray-500">
                              Current chat
                            </span>
                          </div>
                        </Button>
                      )}
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger
                          className={buttonVariants({
                            variant: "ghost",
                            size: "icon",
                            className: "ml-1",
                          })}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="space-y-1 p-2"
                        >
                          <DropdownMenuItem
                            onClick={() =>
                              startRename("current", inlineChatTitle)
                            }
                            className="px-3 py-2"
                          >
                            <Edit3 className="mr-2 h-4 w-4" />
                            <span>Rename Chat</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => setHomeChatMessages([])}
                            className="px-3 py-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/50 focus:bg-red-50 dark:focus:bg-red-950/50"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            <span>Delete Chat</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </SidebarMenuItem>
                )}

                {homeChatHistory.map((entry) => (
                  <SidebarMenuItem key={entry.id} className="mb-1">
                    <div className="flex w-full items-center">
                      {renamingId === entry.id ? (
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={commitRename}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") commitRename();
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          className="flex-1 bg-transparent border-b border-primary text-sm px-2 py-1 outline-none"
                        />
                      ) : (
                        <Button
                          variant="ghost"
                          onClick={() => handleHistoryClick(entry)}
                          className="justify-start flex-1 text-left py-3 pr-1 hover:bg-sidebar-accent/80"
                        >
                          <div className="flex flex-col w-full">
                            <span className="truncate">{entry.title}</span>
                            <span className="text-xs text-gray-500">
                              {formatDistanceToNow(new Date(entry.createdAt), {
                                addSuffix: true,
                              })}
                            </span>
                          </div>
                        </Button>
                      )}
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger
                          className={buttonVariants({
                            variant: "ghost",
                            size: "icon",
                            className: "ml-1",
                          })}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="space-y-1 p-2"
                        >
                          <DropdownMenuItem
                            onClick={() => startRename(entry.id, entry.title)}
                            className="px-3 py-2"
                          >
                            <Edit3 className="mr-2 h-4 w-4" />
                            <span>Rename Chat</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() =>
                              setHomeChatHistory((prev) =>
                                prev.filter((e) => e.id !== entry.id),
                              )
                            }
                            className="px-3 py-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/50 focus:bg-red-50 dark:focus:bg-red-950/50"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            <span>Delete Chat</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </SidebarMenuItem>
                ))}

                {chats.map((chat) => (
                  <SidebarMenuItem key={chat.id} className="mb-1">
                    <div className="flex w-full items-center">
                      {renamingId === String(chat.id) ? (
                        <input
                          autoFocus
                          value={renameValue}
                          onChange={(e) => setRenameValue(e.target.value)}
                          onBlur={() => {
                            handleRenameDbChat(chat.id, renameValue);
                            setRenamingId(null);
                          }}
                          onKeyDown={(e) => {
                            if (e.key === "Enter") {
                              handleRenameDbChat(chat.id, renameValue);
                              setRenamingId(null);
                            }
                            if (e.key === "Escape") setRenamingId(null);
                          }}
                          className="flex-1 bg-transparent border-b border-primary text-sm px-2 py-1 outline-none"
                        />
                      ) : (
                        <Button
                          variant="ghost"
                          onClick={() =>
                            handleChatClick({
                              chatId: chat.id,
                              appId: chat.appId,
                            })
                          }
                          className={`justify-start flex-1 text-left py-3 pr-1 hover:bg-sidebar-accent/80 ${selectedChatId === chat.id ? "bg-sidebar-accent text-sidebar-accent-foreground" : ""}`}
                        >
                          <div className="flex flex-col w-full">
                            <span className="truncate">
                              {chat.title || "New Chat"}
                            </span>
                            <span className="text-xs text-gray-500">
                              {formatDistanceToNow(new Date(chat.createdAt), {
                                addSuffix: true,
                              })}
                            </span>
                          </div>
                        </Button>
                      )}
                      <DropdownMenu modal={false}>
                        <DropdownMenuTrigger
                          className={buttonVariants({
                            variant: "ghost",
                            size: "icon",
                            className: "ml-1",
                          })}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <MoreVertical className="h-4 w-4" />
                        </DropdownMenuTrigger>
                        <DropdownMenuContent
                          align="end"
                          className="space-y-1 p-2"
                        >
                          <DropdownMenuItem
                            onClick={() =>
                              startRename(
                                String(chat.id),
                                chat.title || "New Chat",
                              )
                            }
                            className="px-3 py-2"
                          >
                            <Edit3 className="mr-2 h-4 w-4" />
                            <span>Rename Chat</span>
                          </DropdownMenuItem>
                          <DropdownMenuItem
                            onClick={() => handleDeleteDbChat(chat.id)}
                            className="px-3 py-2 text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/50 focus:bg-red-50 dark:focus:bg-red-950/50"
                          >
                            <Trash2 className="mr-2 h-4 w-4" />
                            <span>Delete Chat</span>
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </div>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            )}
          </div>
        </SidebarGroupContent>
      </SidebarGroup>

      <ChatSearchDialog
        open={isSearchDialogOpen}
        onOpenChange={setIsSearchDialogOpen}
        onSelectChat={handleSearchSelect}
        appId={null}
        allChats={allChatsForSearch}
      />
    </>
  );
}

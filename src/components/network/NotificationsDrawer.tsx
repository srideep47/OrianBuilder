import { useState, useEffect } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import {
  Bell,
  X,
  Wifi,
  WifiOff,
  UserPlus,
  Cpu,
  CheckCheck,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { ipc } from "@/ipc/types";
import { queryKeys } from "@/lib/queryKeys";
import type { Notification } from "@/ipc/types/network";

function timeAgo(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86400_000) return `${Math.floor(diff / 3600_000)}h ago`;
  return `${Math.floor(diff / 86400_000)}d ago`;
}

function NotifIcon({ type }: { type: Notification["type"] }) {
  const cls = "w-4 h-4";
  switch (type) {
    case "peer_online":
      return <Wifi className={`${cls} text-green-500`} />;
    case "peer_offline":
      return <WifiOff className={`${cls} text-muted-foreground`} />;
    case "friend_request":
      return <UserPlus className={`${cls} text-primary`} />;
    case "friend_accepted":
      return <UserPlus className={`${cls} text-green-500`} />;
    case "compute_active":
      return <Cpu className={`${cls} text-blue-500`} />;
    case "compute_done":
      return <Cpu className={`${cls} text-green-500`} />;
    default:
      return <Bell className={cls} />;
  }
}

export function NotificationsDrawer() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [unread, setUnread] = useState(0);

  const { data: notifications = [] } = useQuery<Notification[]>({
    queryKey: queryKeys.network.notifications,
    queryFn: () => ipc.network.getNotifications(),
    refetchInterval: open ? 2000 : 10000,
  });

  const markRead = useMutation({
    mutationFn: () => ipc.network.markNotificationsRead(),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: queryKeys.network.notifications,
      }),
  });

  // Subscribe to live notifications
  useEffect(() => {
    const unsub = ipc.events.network.onNotification(() => {
      queryClient.invalidateQueries({
        queryKey: queryKeys.network.notifications,
      });
    });
    return unsub;
  }, [queryClient]);

  useEffect(() => {
    setUnread(notifications.filter((n) => !n.read).length);
  }, [notifications]);

  const handleOpen = () => {
    setOpen(true);
    if (unread > 0) {
      markRead.mutate();
    }
  };

  return (
    <div className="relative no-app-region-drag">
      <Button
        variant="ghost"
        size="sm"
        className="relative h-8 w-8 p-0"
        onClick={open ? () => setOpen(false) : handleOpen}
      >
        <Bell className="w-4 h-4" />
        {unread > 0 && (
          <span className="absolute -top-0.5 -right-0.5 w-4 h-4 bg-primary text-white text-[10px] font-bold rounded-full flex items-center justify-center">
            {unread > 9 ? "9+" : unread}
          </span>
        )}
      </Button>

      {open && (
        <>
          {/* Backdrop */}
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />

          {/* Panel */}
          <div className="motion-popover liquid-glass-thick absolute right-0 top-11 z-50 flex max-h-[480px] w-80 flex-col rounded-3xl border border-border shadow-xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
              <h3 className="text-sm font-semibold">Activity</h3>
              <div className="flex items-center gap-1">
                {notifications.some((n) => !n.read) && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6 px-2 text-xs text-muted-foreground"
                    onClick={() => markRead.mutate()}
                  >
                    <CheckCheck className="w-3 h-3 mr-1" />
                    Mark all read
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-6 w-6 p-0"
                  onClick={() => setOpen(false)}
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              </div>
            </div>

            <div className="overflow-y-auto flex-1">
              {notifications.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-10 text-center">
                  <Bell className="w-8 h-8 text-muted-foreground/30 mb-2" />
                  <p className="text-sm text-muted-foreground">
                    No activity yet
                  </p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    Peer events will appear here
                  </p>
                </div>
              ) : (
                <div className="py-1">
                  {notifications.map((n) => (
                    <div
                      key={n.id}
                      className={`flex items-start gap-3 px-4 py-3 transition-colors ${
                        !n.read ? "bg-primary/5" : "hover:bg-muted/30"
                      }`}
                    >
                      <div className="mt-0.5 shrink-0">
                        <NotifIcon type={n.type} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium leading-tight">
                          {n.title}
                        </p>
                        {n.body && (
                          <p className="text-xs text-muted-foreground mt-0.5 truncate">
                            {n.body}
                          </p>
                        )}
                        <p className="text-xs text-muted-foreground/60 mt-1">
                          {timeAgo(n.timestamp)}
                        </p>
                      </div>
                      {!n.read && (
                        <span className="w-2 h-2 bg-primary rounded-full shrink-0 mt-1.5" />
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

import React from "react";
import { AlertTriangle } from "lucide-react";

interface ConfirmationDialogProps {
  isOpen: boolean;
  title: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  confirmButtonClass?: string;
  confirmDisabled?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

export default function ConfirmationDialog({
  isOpen,
  title,
  message,
  confirmText = "Confirm",
  cancelText = "Cancel",
  confirmButtonClass = "bg-red-600 hover:bg-red-700 focus:ring-red-500",
  confirmDisabled = false,
  onConfirm,
  onCancel,
}: ConfirmationDialogProps) {
  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 overflow-y-auto">
      <div className="flex min-h-screen items-center justify-center p-4 text-center sm:p-0">
        <div
          className="fixed inset-0 bg-black/30 backdrop-blur-md transition-opacity"
          onClick={onCancel}
        />

        <div className="liquid-glass-thick relative transform overflow-hidden rounded-[24px] border border-black/[0.06] bg-popover/86 text-left shadow-[0_28px_80px_rgba(15,23,42,0.16)] transition-all dark:border-white/[0.08] dark:bg-popover/78 dark:shadow-[0_28px_80px_rgba(0,0,0,0.42)] sm:my-8 sm:w-full sm:max-w-lg">
          <div className="px-4 pb-4 pt-5 sm:p-6 sm:pb-4">
            <div className="sm:flex sm:items-start">
              <div className="mx-auto flex h-12 w-12 flex-shrink-0 items-center justify-center rounded-full border border-red-500/20 bg-red-500/10 sm:mx-0 sm:h-10 sm:w-10">
                <AlertTriangle className="h-5 w-5 text-red-600 dark:text-red-400" />
              </div>
              <div className="mt-3 text-center sm:ml-4 sm:mt-0 sm:text-left">
                <h3 className="text-lg font-semibold leading-6 text-foreground">
                  {title}
                </h3>
                <div className="mt-2">
                  <p className="text-sm text-muted-foreground">{message}</p>
                </div>
              </div>
            </div>
          </div>
          <div className="border-t border-black/[0.06] px-4 py-3 dark:border-white/[0.08] sm:flex sm:flex-row-reverse sm:px-6">
            <button
              type="button"
              className={`inline-flex w-full justify-center rounded-3xl border border-transparent px-4 py-2 text-base font-medium text-white shadow-md focus:outline-none focus:ring-2 focus:ring-offset-2 sm:ml-3 sm:w-auto sm:text-sm ${confirmButtonClass} ${confirmDisabled ? "opacity-50 cursor-not-allowed" : ""}`}
              onClick={onConfirm}
              disabled={confirmDisabled}
            >
              {confirmText}
            </button>
            <button
              type="button"
              className="liquid-glass-thin mt-3 inline-flex w-full justify-center rounded-3xl border border-black/[0.06] bg-white/58 px-4 py-2 text-base font-medium text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.72)] hover:bg-white/72 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 dark:border-white/[0.1] dark:bg-white/[0.06] dark:hover:bg-white/[0.1] sm:mt-0 sm:w-auto sm:text-sm"
              onClick={onCancel}
            >
              {cancelText}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

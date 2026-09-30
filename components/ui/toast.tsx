"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { X, CheckCircle, AlertCircle, Info, AlertTriangle } from "@/components/icons";
import { cn } from "@/lib/utils";

export type ToastType = "success" | "error" | "info" | "warning";

export interface ToastAction {
  label: string;
  onClick: () => void;
}

export interface Toast {
  id: string;
  type: ToastType;
  title: string;
  message?: string;
  duration?: number;
  onClick?: () => void;
  icon?: React.ReactNode;
  action?: ToastAction;
  secondaryAction?: ToastAction;
}

interface ToastProps {
  toast: Toast;
  onClose: (id: string) => void;
}

const icons = {
  success: CheckCircle,
  error: AlertCircle,
  info: Info,
  warning: AlertTriangle,
};

// Only errors and warnings carry colour; success and info stay neutral
// (repos/branding/APP.md).
const iconStyles = {
  success: "text-muted-foreground",
  error: "text-red-600 dark:text-red-400",
  info: "text-muted-foreground",
  warning: "text-amber-600 dark:text-amber-400",
};

const progressBarStyles = {
  success: "bg-muted-foreground",
  error: "bg-destructive",
  info: "bg-muted-foreground",
  warning: "bg-warning",
};

export function ToastItem({ toast, onClose }: ToastProps) {
  const Icon = icons[toast.type];
  const [exiting, setExiting] = useState(false);
  const [paused, setPaused] = useState(false);
  const remainingRef = useRef(toast.duration ?? 5000);
  const startRef = useRef(Date.now());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    setExiting(true);
    setTimeout(() => onClose(toast.id), 280);
  }, [onClose, toast.id]);

  useEffect(() => {
    if (!toast.duration || toast.duration <= 0) return;

    if (paused) {
      if (timerRef.current) clearTimeout(timerRef.current);
      remainingRef.current = remainingRef.current - (Date.now() - startRef.current);
      return;
    }

    startRef.current = Date.now();
    timerRef.current = setTimeout(dismiss, remainingRef.current);
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [toast.duration, paused, dismiss]);

  const actionButton = (action: ToastAction) => (
    <button
      onClick={(e) => {
        e.stopPropagation();
        try {
          action.onClick();
          dismiss();
        } catch {
          // Don't close toast on error so user can retry
        }
      }}
      className={cn(
        "text-[13px] font-semibold text-foreground px-1.5 py-0.5 rounded-md transition-colors",
        "underline underline-offset-[3px] hover:bg-foreground/5"
      )}
    >
      {action.label}
    </button>
  );

  return (
    <div
      className={cn(
        "toast-item group relative flex items-start gap-2.5 w-[360px] max-w-[calc(100vw-2.5rem)] rounded-md",
        "bg-popover text-popover-foreground border border-border",
        "shadow-[0_6px_16px_rgb(0,0,0,0.1)] dark:shadow-[0_6px_16px_rgb(0,0,0,0.4)]",
        "overflow-hidden pt-3 pe-2.5 pb-3.5 ps-3.5",
        exiting ? "toast-exit" : "toast-enter",
        toast.onClick && !toast.action && "cursor-pointer"
      )}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onClick={() => {
        if (toast.onClick && !toast.action) {
          toast.onClick();
          dismiss();
        }
      }}
    >
      {/* Icon */}
      {toast.icon !== undefined ? (
        toast.icon
      ) : (
        <Icon className={cn("w-[18px] h-[18px] flex-shrink-0 mt-px", iconStyles[toast.type])} />
      )}

      {/* Content */}
      <div className="flex-1 min-w-0 pt-px">
        <p className="text-[13.5px] font-medium text-foreground leading-snug">{toast.title}</p>
        {toast.message && (
          <p className="text-[12.5px] mt-0.5 text-muted-foreground leading-snug">{toast.message}</p>
        )}
      </div>

      {(toast.action || toast.secondaryAction) && (
        <div className="flex items-center gap-1 flex-shrink-0">
          {toast.secondaryAction && actionButton(toast.secondaryAction)}
          {toast.action && actionButton(toast.action)}
        </div>
      )}

      {/* Close button */}
      <button
        onClick={(e) => {
          e.stopPropagation();
          dismiss();
        }}
        className={cn(
          "flex-shrink-0 p-1 rounded-md transition-all",
          "text-muted-foreground hover:text-foreground hover:bg-foreground/5",
          "opacity-0 group-hover:opacity-100 group-focus-within:opacity-100"
        )}
      >
        <X className="w-3.5 h-3.5" />
      </button>

      {/* Countdown line */}
      {toast.duration && toast.duration > 0 && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-foreground/[0.06]">
          <div
            className={cn("h-full opacity-60", progressBarStyles[toast.type])}
            style={{
              animation: `toast-progress ${toast.duration}ms linear forwards`,
              animationPlayState: paused ? "paused" : "running",
            }}
          />
        </div>
      )}
    </div>
  );
}

export function ToastContainer({ toasts, onClose }: { toasts: Toast[]; onClose: (id: string) => void }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;

  return createPortal(
    <div
      className="fixed bottom-5 right-5 z-[99999] flex flex-col-reverse gap-2.5"
      role="status"
      aria-live="polite"
      style={{ pointerEvents: "none" }}
    >
      {toasts.map((toast) => (
        <div key={toast.id} style={{ pointerEvents: "auto" }}>
          <ToastItem toast={toast} onClose={onClose} />
        </div>
      ))}
    </div>,
    document.body
  );
}

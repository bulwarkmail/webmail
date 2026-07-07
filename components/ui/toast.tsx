"use client";

import { useEffect, useState, useCallback, useRef } from "react";
import { createPortal } from "react-dom";
import { X, Check, AlertCircle, Info, AlertTriangle } from "lucide-react";
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
}

interface ToastProps {
  toast: Toast;
  onClose: (id: string) => void;
}

const icons = {
  success: Check,
  error: AlertCircle,
  info: Info,
  warning: AlertTriangle,
};

const iconContainerStyles = {
  success: "bg-success text-success-foreground",
  error: "bg-destructive text-destructive-foreground",
  info: "bg-info text-info-foreground",
  warning: "bg-warning text-warning-foreground",
};

const progressBarStyles = {
  success: "bg-success",
  error: "bg-destructive",
  info: "bg-info",
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

  return (
    <div
      className={cn(
        "toast-item group relative flex items-start gap-3 w-[380px] rounded-r-lg",
        "bg-background/95 dark:bg-neutral-900/95 backdrop-blur-sm",
        "border border-border/60 dark:border-neutral-700/60",
        "shadow-[0_8px_30px_rgb(0,0,0,0.08)] dark:shadow-[0_8px_30px_rgb(0,0,0,0.3)]",
        "overflow-hidden",
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
      {/* Left accent bar */}
      <div className={cn("absolute left-0 top-0 bottom-0 w-1", progressBarStyles[toast.type])} />

      <div className="flex items-start gap-3 p-3.5 ps-4.5 flex-1 min-w-0">
        {/* Icon */}
        {toast.icon !== undefined ? (
          toast.icon
        ) : (
          <div className={cn("flex items-center justify-center w-7 h-7 rounded-full flex-shrink-0", iconContainerStyles[toast.type])}>
            <Icon className="w-3.5 h-3.5" strokeWidth={2.5} />
          </div>
        )}

        {/* Content */}
        <div className="flex-1 min-w-0 pt-0.5">
          <p className="text-[13px] font-semibold text-foreground leading-tight">{toast.title}</p>
          {toast.message && (
            <p className="text-[12px] mt-1 text-muted-foreground leading-snug">{toast.message}</p>
          )}
          {toast.action && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                try {
                  toast.action!.onClick();
                  dismiss();
                } catch {
                  // Don't close toast on error so user can retry
                }
              }}
              className={cn(
                "mt-2 text-[12px] font-semibold px-2.5 py-1 rounded-md transition-colors",
                "bg-foreground/5 hover:bg-foreground/10 dark:bg-white/10 dark:hover:bg-white/15",
                "text-foreground"
              )}
            >
              {toast.action.label}
            </button>
          )}
        </div>

        {/* Close button */}
        <button
          onClick={(e) => {
            e.stopPropagation();
            dismiss();
          }}
          className={cn(
            "flex-shrink-0 p-1 rounded-md transition-all",
            "text-muted-foreground/60 hover:text-foreground hover:bg-foreground/5",
            "opacity-0 group-hover:opacity-100"
          )}
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Progress bar */}
      {toast.duration && toast.duration > 0 && (
        <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-foreground/5">
          <div
            className={cn("h-full rounded-full opacity-60", progressBarStyles[toast.type])}
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

import { create } from "zustand";
import { Toast, ToastAction } from "@/components/ui/toast";

interface ToastStore {
  toasts: Toast[];
  addToast: (toast: Omit<Toast, "id">) => void;
  removeToast: (id: string) => void;
  clearToasts: () => void;
}

export const useToastStore = create<ToastStore>((set) => ({
  toasts: [],

  addToast: (toast) => {
    const id = crypto.randomUUID();
    const newToast: Toast = {
      ...toast,
      id,
      duration: toast.duration ?? 5000,
    };

    set((state) => ({
      toasts: [...state.toasts, newToast],
    }));
  },

  removeToast: (id) => {
    set((state) => ({
      toasts: state.toasts.filter((toast) => toast.id !== id),
    }));
  },

  clearToasts: () => {
    set({ toasts: [] });
  },
}));

interface ToastOptions {
  message?: string;
  action?: ToastAction;
  secondaryAction?: ToastAction;
  duration?: number;
}

function showToast(type: Toast["type"], title: string, options?: string | ToastOptions, defaultDuration?: number): void {
  const opts = typeof options === "string" ? { message: options } : options;
  useToastStore.getState().addToast({
    type,
    title,
    message: opts?.message,
    action: opts?.action,
    secondaryAction: opts?.secondaryAction,
    duration: opts?.duration ?? defaultDuration,
  });
}

export const toast = {
  success: (title: string, options?: string | ToastOptions) => showToast("success", title, options),
  error: (title: string, options?: string | ToastOptions) => showToast("error", title, options, 10000),
  info: (title: string, options?: string | ToastOptions) => showToast("info", title, options),
  warning: (title: string, options?: string | ToastOptions) => showToast("warning", title, options),
};

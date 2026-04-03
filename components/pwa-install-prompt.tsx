"use client";

import { useEffect, useState } from "react";
import { X, Download } from "lucide-react";

interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

export function PWAInstallPrompt() {
  const [deferredPrompt, setDeferredPrompt] =
    useState<BeforeInstallPromptEvent | null>(null);
  const [showPrompt, setShowPrompt] = useState(false);

  useEffect(() => {
    const handler = (e: Event) => {
      e.preventDefault();
      setDeferredPrompt(e as BeforeInstallPromptEvent);
      setShowPrompt(true);
    };

    window.addEventListener("beforeinstallprompt", handler);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler);
    };
  }, []);

  const handleInstall = async () => {
    if (!deferredPrompt) return;

    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;

    if (outcome === "accepted") {
      setDeferredPrompt(null);
      setShowPrompt(false);
    }
  };

  const handleDismiss = () => {
    setShowPrompt(false);
  };

  if (!showPrompt || !deferredPrompt) {
    return null;
  }

  return (
    <div className="fixed bottom-4 right-4 z-50 bg-white dark:bg-neutral-900 rounded-lg shadow-lg border border-neutral-200 dark:border-neutral-800 p-4 max-w-sm animate-in slide-in-from-bottom-4">
      <div className="flex items-start justify-between mb-3">
        <div className="flex items-start gap-3">
          <Download className="w-5 h-5 mt-0.5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
          <div>
            <h3 className="font-semibold text-sm text-neutral-900 dark:text-white">
              Install Bulwark
            </h3>
            <p className="text-xs text-neutral-600 dark:text-neutral-400 mt-1">
              Install our app for quick access and offline support.
            </p>
          </div>
        </div>
        <button
          onClick={handleDismiss}
          className="text-neutral-400 hover:text-neutral-600 dark:hover:text-neutral-300 transition-colors"
          aria-label="Dismiss install prompt"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <div className="flex gap-2">
        <button
          onClick={handleDismiss}
          className="flex-1 px-3 py-2 text-sm font-medium text-neutral-700 dark:text-neutral-300 bg-neutral-100 dark:bg-neutral-800 rounded hover:bg-neutral-200 dark:hover:bg-neutral-700 transition-colors"
        >
          Not now
        </button>
        <button
          onClick={handleInstall}
          className="flex-1 px-3 py-2 text-sm font-medium text-white bg-blue-600 rounded hover:bg-blue-700 transition-colors"
        >
          Install
        </button>
      </div>
    </div>
  );
}

"use client";

import { useState, useEffect, useRef } from "react";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useTotpReauthStore } from "@/stores/totp-reauth-store";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Shield } from "lucide-react";

/**
 * Modal dialog that prompts the user for a fresh TOTP code when their
 * 2FA session expires (TOTP rotates every ~30 seconds).
 *
 * Rendered once at the app root level. The JMAP client triggers it via
 * the useTotpReauthStore when a 401 is received on a TOTP-authenticated session.
 */
export function TotpReauthDialog() {
  const { isOpen, submit, cancel } = useTotpReauthStore();
  const [code, setCode] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const dialogRef = useFocusTrap({
    isActive: isOpen,
    onEscape: cancel,
    restoreFocus: true,
  });

  useEffect(() => {
    if (isOpen) {
      setCode("");
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (code.length >= 6) {
      submit(code);
    }
  };

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={cancel} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="Two-factor authentication required"
        className="relative z-10 w-full max-w-sm mx-4 bg-background rounded-2xl shadow-xl border border-border p-6"
      >
        <div className="flex items-center gap-3 mb-4">
          <div className="flex items-center justify-center w-10 h-10 rounded-full bg-primary/10">
            <Shield className="w-5 h-5 text-primary" />
          </div>
          <div>
            <h2 className="text-lg font-semibold text-foreground">Session Expired</h2>
            <p className="text-sm text-muted-foreground">Your 2FA code has rotated</p>
          </div>
        </div>

        <p className="text-sm text-muted-foreground mb-4">
          Enter a fresh authentication code from your authenticator app to continue.
        </p>

        <p className="text-xs text-amber-600 dark:text-amber-400 mb-4 leading-relaxed">
          To avoid being prompted repeatedly, ask your administrator to enable OAuth authentication
          (either Stalwart&apos;s built-in OAuth or an external identity provider).
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <Input
            ref={inputRef}
            type="text"
            inputMode="numeric"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))}
            className="h-12 text-center font-mono tracking-widest text-lg bg-muted/40 border-border/60 rounded-xl focus:bg-background focus:border-primary/50 transition-all duration-200"
            placeholder="000000"
            autoComplete="one-time-code"
            aria-label="Authentication code"
          />
          <div className="flex gap-3">
            <Button
              type="button"
              variant="outline"
              className="flex-1"
              onClick={cancel}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              className="flex-1"
              disabled={code.length < 6}
            >
              Verify
            </Button>
          </div>
        </form>
      </div>
    </div>
  );
}

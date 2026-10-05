"use client";

import { useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { Maximize2, Minimize2, Minus } from "@/components/icons";
import { cn } from "@/lib/utils";

type WindowState = "normal" | "minimized" | "maximized";

/**
 * Mountain View's compose window: a panel docked at the bottom-right corner
 * over the mail list, which can be folded down to its title bar or opened up
 * to a large centred dialog. The composer inside stays mounted throughout, so folding it
 * keeps the draft exactly as it was.
 */
export function MvComposeWindow({ children }: { children: ReactNode }) {
  const t = useTranslations("email_composer");
  const [state, setState] = useState<WindowState>("normal");
  const minimized = state === "minimized";
  const maximized = state === "maximized";

  return (
    <>
      {maximized && (
        <div
          className="fixed inset-0 z-40 bg-black/40"
          aria-hidden
          onClick={() => setState("normal")}
        />
      )}
      <div
        data-mv-compose-window=""
        data-state={state}
        className={cn(
          "fixed z-40 flex flex-col overflow-hidden border border-border bg-background shadow-2xl",
          maximized
            ? "inset-x-[8vw] inset-y-[6vh] rounded-2xl"
            : "bottom-0 end-6 w-[min(560px,calc(100vw-3rem))] rounded-t-2xl",
          minimized && "h-14",
          state === "normal" && "h-[min(640px,calc(100dvh-5rem))]",
        )}
      >
        <div className="absolute top-2.5 end-3 z-10 flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => setState(minimized ? "normal" : "minimized")}
            className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={minimized ? t("restore") : t("minimize")}
            title={minimized ? t("restore") : t("minimize")}
          >
            <Minus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => setState(maximized ? "normal" : "maximized")}
            className="grid h-8 w-8 place-items-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label={maximized ? t("restore") : t("maximize")}
            title={maximized ? t("restore") : t("maximize")}
          >
            {maximized ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        </div>
        {/* Folded down, the title bar is the whole window and opens it again. */}
        {minimized && (
          <button
            type="button"
            className="absolute inset-0 end-24 z-[5]"
            aria-label={t("restore")}
            onClick={() => setState("normal")}
          />
        )}
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </>
  );
}

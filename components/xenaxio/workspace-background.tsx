"use client";

// Step 41: puts the chosen background under the web client (the person's own,
// else the company's default). Only once signed in: the sign-in page keeps
// its plain look. Styles: workspace-background.css.
import { useEffect } from "react";
import "./workspace-background.css";
import { backgroundCss, effectiveBackground } from "@/lib/xenaxio/backgrounds";
import { useXenaxioMe } from "@/lib/xenaxio/me-store";
import { XENAXIO_BFF } from "@/lib/xenaxio/bff";

export function WorkspaceBackground() {
  const me = useXenaxioMe();
  const bg = XENAXIO_BFF ? effectiveBackground(me?.background, me?.portal?.background) : null;
  const id = bg?.id;

  useEffect(() => {
    const root = document.documentElement;
    if (id) root.dataset.xenaxioBg = id;
    else delete root.dataset.xenaxioBg;
    return () => {
      delete root.dataset.xenaxioBg;
    };
  }, [id]);

  if (!bg) return null;
  // Built only from the client's own list of backgrounds and a validated colour.
  return <style data-xenaxio-background="">{backgroundCss(bg, me?.portal?.color)}</style>;
}

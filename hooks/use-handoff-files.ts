"use client";

import { useCallback, useEffect, useState } from "react";
import { subscribeHandoff, takeHandoff, type HandoffKind } from "@/lib/launch-handoff";

/**
 * The files handed to this part of the app (lib/launch-handoff.ts), one at a
 * time. Nothing is taken while `active` is false, for a surface that isn't
 * ready for them yet. `done` moves on to the next file.
 */
export function useHandoffFiles(kind: HandoffKind, active: boolean): { file: File | null; done: () => void } {
  const [files, setFiles] = useState<File[]>([]);

  useEffect(() => {
    if (!active) return;
    const take = () => {
      for (let handoff = takeHandoff(kind); handoff; handoff = takeHandoff(kind)) {
        const received = handoff.files;
        if (received.length > 0) setFiles((waiting) => [...waiting, ...received]);
      }
    };
    take();
    return subscribeHandoff(kind, take);
  }, [kind, active]);

  const done = useCallback(() => setFiles((waiting) => waiting.slice(1)), []);
  return { file: files[0] ?? null, done };
}

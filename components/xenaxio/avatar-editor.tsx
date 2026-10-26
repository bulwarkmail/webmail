"use client";

// Step 39: a picture with "upload" and "remove": one's own (target null) or,
// for the admin, an employee's, a shared mailbox's or a resource's.
import { type ChangeEvent, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Camera, Trash2 } from "@/components/icons";
import { withBasePath } from "@/lib/browser-navigation";
import { generateAvatarColor, getInitials } from "@/lib/account-utils";
import { cn } from "@/lib/utils";
import { type AvatarTarget, errorText, xenaxio } from "@/lib/xenaxio/api";
import { squareAvatar, useXenaxioAvatarStore } from "@/lib/xenaxio/avatars";
import { useXT } from "@/lib/xenaxio/i18n";

export function AvatarEditor({
  target,
  url,
  name,
  email,
  size = "md",
  onChanged,
}: {
  target: AvatarTarget;
  url: string | null | undefined;
  name: string;
  email: string;
  size?: "md" | "lg";
  onChanged?: (url: string | null) => void;
}) {
  const t = useXT();
  const fileInput = useRef<HTMLInputElement>(null);
  const [current, setCurrent] = useState(url ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshDirectory = useXenaxioAvatarStore((s) => s.load);

  const run = async (action: () => Promise<string | null>) => {
    setBusy(true);
    setError(null);
    try {
      const next = await action();
      setCurrent(next);
      onChanged?.(next);
      // The mail app shows the new picture without a reload.
      void refreshDirectory(true);
    } catch (err) {
      setError(errorText(t, err));
    } finally {
      setBusy(false);
    }
  };

  const upload = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!file) return;
    if (!file.type.startsWith("image/")) return setError(t("errors.avatar_invalid_type"));
    let image: Blob;
    try {
      image = await squareAvatar(file);
    } catch {
      // HEIC on some browsers, a broken file: the browser cannot draw it.
      return setError(t("avatar.unreadable"));
    }
    await run(async () => (await xenaxio.uploadAvatar(target, image)).avatarUrl);
  };

  const side = size === "lg" ? "w-20 h-20 text-2xl" : "w-10 h-10 text-sm";
  const label = name || email;
  return (
    <div className="flex flex-wrap items-center gap-3">
      <div
        className={cn("rounded-full overflow-hidden flex items-center justify-center font-semibold text-white shrink-0", side)}
        style={{ backgroundColor: current ? "transparent" : generateAvatarColor(email) }}
        title={label}
      >
        {current ? <img src={withBasePath(current)} alt={t("avatar.alt", { name: label })} className="w-full h-full object-cover" /> : getInitials(name, email)}
      </div>
      <input ref={fileInput} type="file" accept="image/*" className="hidden" onChange={upload} aria-label={t("avatar.upload_for", { name: label })} />
      <div className="flex flex-wrap items-center gap-1">
        <Button type="button" variant="outline" size="sm" onClick={() => fileInput.current?.click()} disabled={busy}>
          <Camera className="w-4 h-4 mr-1.5" />
          {busy ? t("avatar.saving") : current ? t("avatar.replace") : t("avatar.upload")}
        </Button>
        {current && (
          <Button type="button" variant="ghost" size="sm" onClick={() => run(async () => (await xenaxio.removeAvatar(target)).avatarUrl)} disabled={busy}>
            <Trash2 className="w-4 h-4 mr-1.5" />
            {t("avatar.remove")}
          </Button>
        )}
      </div>
      {error && <p className="basis-full text-sm text-destructive" role="alert">{error}</p>}
    </div>
  );
}

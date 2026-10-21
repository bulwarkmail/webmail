"use client";

// Spec W1 / AGPL-3.0: name the upstream project, the license and where the
// source of this very build is.
import { useConfig } from "@/hooks/use-config";
import { useXT } from "@/lib/xenaxio/i18n";

const UPSTREAM_URL = "https://github.com/bulwarkmail/webmail";
const OWN_SOURCE_URL = "https://github.com/xenaxiocom/webmail";

export function AboutAttribution() {
  const t = useXT();
  const { sourceCodeUrl } = useConfig();
  const link = "underline underline-offset-2 hover:text-foreground";
  return (
    <p className="mt-1.5 text-[11px] leading-snug text-muted-foreground">
      {t("about.based_on")}{" "}
      <a href={UPSTREAM_URL} target="_blank" rel="noopener noreferrer" className={link}>
        Bulwark Mail
      </a>
      {" · "}
      <a href="https://www.gnu.org/licenses/agpl-3.0.html" target="_blank" rel="noopener noreferrer" className={link}>
        AGPL-3.0
      </a>
      {" · "}
      <a href={sourceCodeUrl || OWN_SOURCE_URL} target="_blank" rel="noopener noreferrer" className={link}>
        {t("about.source")}
      </a>
    </p>
  );
}

"use client";

// Step 46: a task the assistant made from an email carries a link to it in
// its description. The task window shows it as a button that opens the email
// here in the app; only links to an email of this client count.
import { Link } from "@/i18n/navigation";
import { Mail } from "@/components/icons";
import { useXT } from "@/lib/xenaxio/i18n";

const URL_RE = /https?:\/\/[^\s<>"]+/g;
const MESSAGE_PATH = /^\/(?:[a-z]{2}(?:-[A-Za-z]{2})?\/)?mail\/message\/([^/]+)$/;

/** The app path of the first email link in a task description, e.g. "/mail/message/abc?account=x". */
export function emailPathFromDescription(text: string | null | undefined): string | null {
  for (const raw of (text ?? "").match(URL_RE) ?? []) {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    const id = MESSAGE_PATH.exec(url.pathname)?.[1];
    if (!id) continue;
    const account = url.searchParams.get("account");
    // Only the path is kept: the link opens the email in this app, never another site.
    return `/mail/message/${id}${account ? `?account=${encodeURIComponent(account)}` : ""}`;
  }
  return null;
}

export function TaskEmailLink({ description }: { description: string | null | undefined }) {
  const t = useXT();
  const path = emailPathFromDescription(description);
  if (!path) return null;
  return (
    <Link href={path} className="inline-flex items-center gap-1.5 text-sm text-primary underline-offset-2 hover:underline">
      <Mail className="h-4 w-4" />
      {t("assistant.task.open_email")}
    </Link>
  );
}

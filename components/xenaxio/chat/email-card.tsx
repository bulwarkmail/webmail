"use client";

// Step 43, part D: an e-mail shared into the chat. The card shows subject,
// sender and the beginning; the link opens the e-mail for whoever has it
// (their own mailbox or a shared one, e.g. info@). Others see only the card.
import { IconMail } from "@tabler/icons-react";
import { useLocale } from "next-intl";
import { Link } from "@/i18n/navigation";
import { messageRouteId } from "@/lib/xenaxio/assistant";
import type { SharedEmail } from "@/lib/xenaxio/chat/format";
import { useXT } from "@/lib/xenaxio/i18n";

export function EmailCard({ email }: { email: SharedEmail }) {
  const t = useXT();
  const locale = useLocale();
  const date = email.date ? new Date(email.date).toLocaleString(locale, { dateStyle: "medium", timeStyle: "short" }) : null;
  return (
    <div className="mt-1 max-w-xl rounded-md border border-border border-l-4 border-l-primary bg-background p-3">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <IconMail size={14} />
        <span>{t("chat.email_card")}</span>
        {date && <span>· {date}</span>}
      </div>
      <div className="mt-1 text-sm font-semibold">{email.subject || t("chat.email_no_subject")}</div>
      <div className="text-xs text-muted-foreground">
        {email.from}
        {email.fromEmail && email.fromEmail !== email.from && ` <${email.fromEmail}>`}
      </div>
      {email.preview && <p className="mt-1 line-clamp-3 text-sm">{email.preview}</p>}
      <Link href={`/mail/message/${encodeURIComponent(messageRouteId(email.emailId))}`} className="mt-2 inline-block text-xs font-medium text-primary hover:underline">
        {t("chat.email_open")}
      </Link>
      <p className="mt-1 text-[11px] text-muted-foreground">{t("chat.email_access_note")}</p>
    </div>
  );
}

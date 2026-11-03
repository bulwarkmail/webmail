import { getTranslations } from "next-intl/server";
import { MailtoProtocolClient } from "@/components/protocol/mailto-protocol-client";

export default async function MailtoProtocolPage() {
  const t = await getTranslations("protocol_handlers");
  const tSidebar = await getTranslations("sidebar");
  const labels = {
    mail: tSidebar("mail"),
    calendar: tSidebar("calendar"),
    contacts: tSidebar("contacts"),
    files: tSidebar("files"),
    settings: tSidebar("settings"),
  };

  return <MailtoProtocolClient openingText={t("opening_mailto")} labels={labels} />;
}

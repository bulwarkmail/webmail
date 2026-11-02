import { getTranslations } from "next-intl/server";
import { WebcalProtocolClient } from "@/components/protocol/webcal-protocol-client";
import { calendarSkeletonText } from "@/components/boot-skeleton/calendar-skeleton";

export default async function WebcalProtocolPage() {
  const t = await getTranslations("protocol_handlers");
  const tSidebar = await getTranslations("sidebar");
  const tCalendar = await getTranslations("calendar");

  return (
    <WebcalProtocolClient
      openingText={t("opening_webcal")}
      labels={{
        mail: tSidebar("mail"),
        calendar: tSidebar("calendar"),
        contacts: tSidebar("contacts"),
        files: tSidebar("files"),
        settings: tSidebar("settings"),
      }}
      text={calendarSkeletonText(tCalendar)}
    />
  );
}

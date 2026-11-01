"use client";

import { useTranslations } from "next-intl";
import type { RailLabels } from "./shell";

/**
 * The few strings a page skeleton shows: the status message and the phone
 * bottom bar's labels. For the gates of client pages, which have the message
 * catalog; the skeleton components themselves stay free of next-intl.
 */
export function useSkeletonLabels(): { label: string; labels: RailLabels } {
  const t = useTranslations();
  return {
    label: t("common.loading"),
    labels: {
      mail: t("sidebar.mail"),
      calendar: t("sidebar.calendar"),
      contacts: t("sidebar.contacts"),
      files: t("sidebar.files"),
      settings: t("sidebar.settings"),
      admin: t("sidebar.admin"),
    },
  };
}

"use client";

import { useId } from "react";
import { useFocusTrap } from "@/hooks/use-focus-trap";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { ShieldCheck, X } from "lucide-react";
import type { SmimeKeyRecord, SmimePublicCert } from "@/lib/smime/types";

interface SmimeCertificateModalProps {
  isOpen: boolean;
  onClose: () => void;
  record: SmimeKeyRecord | SmimePublicCert | null;
  type: "private" | "public";
}

export function SmimeCertificateModal({
  isOpen,
  onClose,
  record,
  type: _type,
}: SmimeCertificateModalProps) {
  const t = useTranslations("smime");
  const id = useId();

  const dialogRef = useFocusTrap({
    isActive: isOpen,
    onEscape: onClose,
    restoreFocus: true,
  });

  if (!isOpen || !record) return null;

  const isExpired = new Date(record.notAfter) < new Date();
  const isNotYetValid = new Date(record.notBefore) > new Date();

  const rows: { label: string; value: string }[] = [
    { label: t("cert_subject"), value: record.subject ?? "" },
    { label: t("cert_issuer"), value: record.issuer ?? "" },
    { label: t("cert_email"), value: record.email },
    {
      label: t("cert_validity"),
      value: `${new Date(record.notBefore).toLocaleDateString()} - ${new Date(record.notAfter).toLocaleDateString()}`,
    },
    { label: t("cert_fingerprint"), value: record.fingerprint },
  ];

  if ("serialNumber" in record) {
    rows.splice(2, 0, { label: t("cert_serial"), value: record.serialNumber });
  }

  if ("algorithm" in record) {
    rows.push({ label: t("cert_algorithm"), value: record.algorithm });
  }

  if ("capabilities" in record) {
    const caps: string[] = [];
    if (record.capabilities.canSign) caps.push(t("cap_sign"));
    if (record.capabilities.canEncrypt) caps.push(t("cap_encrypt"));
    rows.push({ label: t("cert_capabilities"), value: caps.join(", ") || t("cap_none") });
  }

  if ("source" in record) {
    rows.push({ label: t("cert_source"), value: record.source });
  }

  return (
    <div className="fixed inset-0 bg-black/50 backdrop-blur-[1px] flex items-center justify-center z-[60] p-4 animate-in fade-in duration-150">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        className="bg-background border border-border rounded-lg shadow-xl w-full max-w-lg animate-in zoom-in-95 duration-200"
      >
        <div className="flex items-center justify-between p-6 pb-4 border-b border-border">
          <div className="flex items-center gap-3">
            <div className="w-9 h-9 rounded-full bg-primary/10 flex items-center justify-center">
              <ShieldCheck className="w-5 h-5 text-primary" />
            </div>
            <h2 id={`${id}-title`} className="text-lg font-semibold text-foreground">
              {t("certificate_details")}
            </h2>
          </div>
          <Button variant="ghost" size="icon" onClick={onClose}>
            <X className="w-4 h-4" />
          </Button>
        </div>

        <div className="p-6 space-y-3 max-h-[60vh] overflow-y-auto">
          {(isExpired || isNotYetValid) && (
            <div className="px-3 py-2 rounded-md bg-destructive/10 text-destructive text-sm">
              {isExpired ? t("cert_expired") : t("cert_not_yet_valid")}
            </div>
          )}

          {rows.map(({ label, value }) => (
            <div key={label}>
              <dt className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
                {label}
              </dt>
              <dd className="text-sm text-foreground mt-0.5 break-all font-mono">
                {value}
              </dd>
            </div>
          ))}
        </div>

        <div className="flex justify-end px-6 pb-6">
          <Button variant="ghost" onClick={onClose}>
            {t("close")}
          </Button>
        </div>
      </div>
    </div>
  );
}

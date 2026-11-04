/**
 * The client certificate picker's text in the interface language, by its keys in the shell's
 * src/main/strings.ts. The shell fills in the {placeholders} itself, so they go through as
 * they are. It goes out with the rest of the labels in shellLabels (languages.ts).
 */
export function certificateLabels(t: (key: string, values?: Record<string, string>) => string): Record<string, string> {
  const keep = { host: '{host}', issuer: '{issuer}', date: '{date}' };
  return {
    certificateTitle: t('desktop_certificates.picker_title', keep),
    certificateDetail: t('desktop_certificates.picker_detail'),
    certificateIssued: t('desktop_certificates.picker_issued', keep),
    certificateRemember: t('desktop_certificates.picker_remember', keep),
    certificateNone: t('desktop_certificates.picker_none'),
    certificateMore: t('desktop_certificates.picker_more'),
  };
}

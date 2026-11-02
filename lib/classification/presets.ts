/**
 * The two label schemes the admin page offers to start from (enterprise
 * pack item 3). Markings follow RFC 7444 (SIO-Label), Sensitivity values
 * RFC 2156 (what Outlook shows).
 *
 * The German public-sector preset stops at VS-NfD on purpose: higher grades
 * (VS-VERTRAULICH and up) need IT approved for them (VSA § 50 Abs. 4) and
 * must not be offered in a mail client that isn't. Even VS-NfD needs
 * approved IT and BSI-approved encryption outside an approved network
 * (§ 50, § 55); the label only marks the message.
 */

import type { ClassificationLabel } from '@/lib/admin/organisation-policy';

export interface LabelPreset {
  id: 'generic' | 'german-public-sector';
  name: string;
  defaultId: string;
  list: ClassificationLabel[];
}

const label = (l: Partial<ClassificationLabel> & Pick<ClassificationLabel, 'id' | 'name' | 'color' | 'marking'>): ClassificationLabel => ({
  description: '',
  sensitivity: '',
  subjectPrefix: '',
  extraHeaderValue: '',
  ...l,
});

export const LABEL_PRESETS: LabelPreset[] = [
  {
    id: 'generic',
    name: 'Generic: Public / Internal / Confidential / Strictly confidential',
    defaultId: 'internal',
    list: [
      label({ id: 'public', name: 'Public', color: '#16a34a', marking: 'PUBLIC', description: 'Can be shared with anyone.', extraHeaderValue: 'Public' }),
      label({ id: 'internal', name: 'Internal', color: '#2563eb', marking: 'INTERNAL', description: 'For people in the organisation and those working with it.', extraHeaderValue: 'Internal' }),
      label({
        id: 'confidential', name: 'Confidential', color: '#d97706', marking: 'CONFIDENTIAL', sensitivity: 'Company-Confidential',
        subjectPrefix: '[Confidential]', description: 'Only for the people it is meant for.', extraHeaderValue: 'Confidential',
      }),
      label({
        id: 'strictly-confidential', name: 'Strictly confidential', color: '#dc2626', marking: 'STRICTLY CONFIDENTIAL',
        sensitivity: 'Company-Confidential', subjectPrefix: '[Strictly confidential]',
        description: 'Only for the named recipients. Don’t forward.', extraHeaderValue: 'Strictly confidential',
      }),
    ],
  },
  {
    id: 'german-public-sector',
    name: 'German public sector: OFFEN / VS-NfD',
    defaultId: 'offen',
    list: [
      label({ id: 'offen', name: 'OFFEN', color: '#6b7280', marking: 'OFFEN', description: 'Nicht eingestuft.', extraHeaderValue: 'OFFEN' }),
      label({
        id: 'vs-nfd', name: 'VS-NfD', color: '#b91c1c', marking: 'VS-NUR FÜR DEN DIENSTGEBRAUCH', sensitivity: 'Company-Confidential',
        subjectPrefix: 'VS-NfD',
        description: 'Verschlusssache – nur für den Dienstgebrauch. Nur nach der VSA behandeln und versenden.',
        extraHeaderValue: 'VS-NfD',
      }),
    ],
  },
];

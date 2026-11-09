import type { Identity } from '@/lib/jmap/types';
import type { SignatureDetails } from '@/lib/org-signature';
import { NORA, NORA_ALIAS, SUPPORT } from './people';

/**
 * What Nora filled in under Settings > Account > Your details, for the
 * organisation signature an administrator sets (lib/org-signature.ts).
 * The same title and phone as her own signature below.
 */
export const DEMO_SIGNATURE_DETAILS: SignatureDetails = {
  title: 'Engineering Lead',
  department: 'Platform',
  phone: '+49 30 555 0199',
  mobile: '',
};

export function createDemoIdentities(): Identity[] {
  return [
    {
      id: 'demo-identity-primary',
      name: NORA.name,
      email: NORA.email,
      textSignature: 'Nora Lindqvist\nEngineering Lead, Meridian Labs\n+49 30 555 0199',
      htmlSignature: '<p><b>Nora Lindqvist</b><br>Engineering Lead, Meridian Labs<br>+49 30 555 0199</p>',
      mayDelete: false,
    },
    {
      id: 'demo-identity-alias',
      name: NORA_ALIAS.name,
      email: NORA_ALIAS.email,
      textSignature: 'Nora Lindqvist\nMeridian Labs',
      htmlSignature: '<p>Nora Lindqvist<br>Meridian Labs</p>',
      mayDelete: true,
    },
    {
      id: 'demo-identity-support',
      name: 'Meridian Support',
      email: SUPPORT.email,
      replyTo: [{ name: 'Meridian Support', email: SUPPORT.email }],
      textSignature: 'Nora, for Meridian Support\nsupport@meridianlabs.example',
      htmlSignature: '<p>Nora, for Meridian Support<br>support@meridianlabs.example</p>',
      mayDelete: true,
    },
  ];
}

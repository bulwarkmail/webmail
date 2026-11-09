import { usePolicyStore } from '@/stores/policy-store';

// The admin policy's `structuredMailEnabled` gate. Off: no booking, parcel or
// order cards, no parsing of markup and no .pkpass download.

/** Whether booking cards are shown, for components. */
export function useStructuredMailEnabled(): boolean {
  return usePolicyStore((s) => s.isFeatureEnabled('structuredMailEnabled'));
}

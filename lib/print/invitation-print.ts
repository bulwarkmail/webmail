/**
 * What an invitation's card says, for the printout of its message. The card works its
 * details out itself (components/email/calendar-invitation-banner.tsx); the print copy
 * (components/email/message-print.tsx) only shows the header and the body, so without
 * this a printed invitation lost when and where, the part people print it for.
 */

import { useEffect } from 'react';
import { create } from 'zustand';

export interface InvitationPrint {
  heading: string;
  rows: Array<[label: string, value: string]>;
}

const useInvitations = create<Record<string, InvitationPrint>>(() => ({}));

export function setInvitationPrint(emailId: string, print: InvitationPrint | null): void {
  useInvitations.setState((state) => {
    const next = { ...state };
    if (print) next[emailId] = print;
    else delete next[emailId];
    return next;
  }, true);
}

export function useInvitationPrint(emailId: string | undefined): InvitationPrint | null {
  return useInvitations((state) => (emailId ? state[emailId] ?? null : null));
}

/** Rendered by the card while its details are known; takes them away again when it goes. */
export function InvitationPrintSync({ emailId, print }: { emailId: string; print: InvitationPrint }): null {
  const key = JSON.stringify(print);
  useEffect(() => {
    setInvitationPrint(emailId, JSON.parse(key) as InvitationPrint);
    return () => setInvitationPrint(emailId, null);
  }, [emailId, key]);
  return null;
}

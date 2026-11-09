import type { VacationResponse } from '@/lib/jmap/types';
import { demoAt } from '../demo-utils';

/**
 * Filled in for the Lisbon trip (Infra Summit in fixtures/calendars.ts,
 * days 9 to 12): from the morning flight out to the evening flight back.
 * Left off: switched on, the sidebar says so in every view, whatever the
 * dates. Turning it on in Settings shows the filled form.
 */
export function createDemoVacationResponse(): VacationResponse {
  return {
    id: 'singleton',
    isEnabled: false,
    fromDate: demoAt(9, 6),
    toDate: demoAt(12, 22),
    subject: 'Out of office: back next week',
    textBody: 'Thank you for your mail. I am at Infra Summit in Lisbon and reading mail slowly until next week.\n\nFor anything about the Beacon launch, Alice Johnson (alice.johnson@meridianlabs.example) has the plan. For customer questions, support@meridianlabs.example answers within a business day.\n\nNora',
    htmlBody: '<p>Thank you for your mail. I am at Infra Summit in Lisbon and reading mail slowly until next week.</p><p>For anything about the Beacon launch, <a href="mailto:alice.johnson@meridianlabs.example">Alice Johnson</a> has the plan. For customer questions, <a href="mailto:support@meridianlabs.example">support@meridianlabs.example</a> answers within a business day.</p><p>Nora</p>',
  };
}

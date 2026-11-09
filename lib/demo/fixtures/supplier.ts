/**
 * Mail from suppliers: Spreehost's monthly hosting invoice, with the
 * XRechnung the E-Invoices plugin shows as an invoice (fixtures/invoice.ts).
 */
import type { Email } from '@/lib/jmap/types';
import { ago, authPass, mail } from './mail';
import { MB } from './mailboxes';
import { addr, SPREEHOST } from './people';
import { INVOICE_BLOB, INVOICE_FILE, INVOICE_NUMBER, INVOICE_TOTAL, invoiceDates, invoiceSize } from './invoice';

export const INVOICE_EMAIL_ID = 'demo-email-spreehost-invoice';

export function createDemoSupplierEmails(): Email[] {
  const due = new Date(`${invoiceDates().due}T12:00:00`).toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
  return [
    mail({
      id: INVOICE_EMAIL_ID, mailbox: MB.inbox, date: ago(2, 25),
      from: addr(SPREEHOST),
      subject: `Your invoice ${INVOICE_NUMBER}`,
      text: `Hello Meridian Labs,\n\nYour invoice ${INVOICE_NUMBER} for last month is attached as an XRechnung (XML).\n\nAmount due: ${INVOICE_TOTAL} EUR, payable by ${due} to the account on the invoice. Please quote the invoice number with your payment.\n\nQuestions about the invoice: reply to this mail.\n\nSpreehost GmbH\nKöpenicker Straße 154, 10997 Berlin`,
      attachments: [{ partId: 'att-invoice-xml', blobId: INVOICE_BLOB, size: invoiceSize(), name: INVOICE_FILE, type: 'application/xml' }],
      keywords: ['$label:finance'],
      headers: authPass('spreehost.example'),
    }),
  ];
}

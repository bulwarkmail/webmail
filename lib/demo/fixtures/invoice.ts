/**
 * The monthly hosting invoice from Spreehost, Meridian Labs' (made-up)
 * hosting company, as an XRechnung 3.0 in UBL: what the E-Invoices plugin
 * (repos/plugins e-invoice) shows as a readable invoice. Adapted from that
 * plugin's own test fixture (e-invoice/test/fixtures/xrechnung-ubl.xml,
 * AGPL-3.0 like this repo) with the cast's names and amounts.
 *
 * The XML is built when it is fetched, like the go/no-go .ics: its dates
 * follow the demo's clock, so the invoice is never shown as overdue. Every
 * date is YYYY-MM-DD, so its length, and the attachment size, stay the same.
 */
export const INVOICE_BLOB = 'demo-blob-spreehost-invoice';
export const INVOICE_NUMBER = 'SH-2026-10418';
export const INVOICE_FILE = `${INVOICE_NUMBER}.xml`;

/** A local date, `days` from today, as YYYY-MM-DD. */
function localDate(days: number, base = new Date()): string {
  const d = new Date(base);
  d.setDate(d.getDate() + days);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Issued yesterday for the month before, due two weeks later. */
export function invoiceDates(now = new Date()) {
  const issued = new Date(now);
  issued.setDate(issued.getDate() - 1);
  const periodEnd = new Date(issued.getFullYear(), issued.getMonth(), 0);
  const periodStart = new Date(periodEnd.getFullYear(), periodEnd.getMonth(), 1);
  return {
    issue: localDate(0, issued),
    due: localDate(14, issued),
    periodStart: localDate(0, periodStart),
    periodEnd: localDate(0, periodEnd),
  };
}

/** Net 571.00, VAT 19% 108.49, total and due 679.49 EUR. */
export const INVOICE_TOTAL = '679.49';

const line = (id: number, name: string, description: string, quantity: number, price: string, amount: string) => `
  <cac:InvoiceLine>
    <cbc:ID>${id}</cbc:ID>
    <cbc:InvoicedQuantity unitCode="C62">${quantity}</cbc:InvoicedQuantity>
    <cbc:LineExtensionAmount currencyID="EUR">${amount}</cbc:LineExtensionAmount>
    <cac:Item>
      <cbc:Description>${description}</cbc:Description>
      <cbc:Name>${name}</cbc:Name>
      <cac:ClassifiedTaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:ClassifiedTaxCategory>
    </cac:Item>
    <cac:Price><cbc:PriceAmount currencyID="EUR">${price}</cbc:PriceAmount></cac:Price>
  </cac:InvoiceLine>`;

export function createSpreehostInvoiceXml(now = new Date()): string {
  const d = invoiceDates(now);
  return `<?xml version="1.0" encoding="UTF-8"?>
<ubl:Invoice xmlns:ubl="urn:oasis:names:specification:ubl:schema:xsd:Invoice-2"
             xmlns:cac="urn:oasis:names:specification:ubl:schema:xsd:CommonAggregateComponents-2"
             xmlns:cbc="urn:oasis:names:specification:ubl:schema:xsd:CommonBasicComponents-2">
  <cbc:CustomizationID>urn:cen.eu:en16931:2017#compliant#urn:xeinkauf.de:kosit:xrechnung_3.0</cbc:CustomizationID>
  <cbc:ProfileID>urn:fdc:peppol.eu:2017:poacc:billing:01:1.0</cbc:ProfileID>
  <cbc:ID>${INVOICE_NUMBER}</cbc:ID>
  <cbc:IssueDate>${d.issue}</cbc:IssueDate>
  <cbc:DueDate>${d.due}</cbc:DueDate>
  <cbc:InvoiceTypeCode>380</cbc:InvoiceTypeCode>
  <cbc:Note>Thank you for hosting with Spreehost. Please quote the invoice number with your payment.</cbc:Note>
  <cbc:DocumentCurrencyCode>EUR</cbc:DocumentCurrencyCode>
  <cbc:BuyerReference>PO-2026-0398</cbc:BuyerReference>
  <cac:InvoicePeriod>
    <cbc:StartDate>${d.periodStart}</cbc:StartDate>
    <cbc:EndDate>${d.periodEnd}</cbc:EndDate>
  </cac:InvoicePeriod>
  <cac:OrderReference><cbc:ID>PO-2026-0398</cbc:ID></cac:OrderReference>
  <cac:AccountingSupplierParty>
    <cac:Party>
      <cbc:EndpointID schemeID="EM">billing@spreehost.example</cbc:EndpointID>
      <cac:PartyName><cbc:Name>Spreehost</cbc:Name></cac:PartyName>
      <cac:PostalAddress>
        <cbc:StreetName>Köpenicker Straße 154</cbc:StreetName>
        <cbc:CityName>Berlin</cbc:CityName>
        <cbc:PostalZone>10997</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyTaxScheme>
        <cbc:CompanyID>DE298765432</cbc:CompanyID>
        <cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme>
      </cac:PartyTaxScheme>
      <cac:PartyLegalEntity>
        <cbc:RegistrationName>Spreehost GmbH</cbc:RegistrationName>
        <cbc:CompanyID>HRB 214477 B</cbc:CompanyID>
      </cac:PartyLegalEntity>
      <cac:Contact>
        <cbc:Name>Spreehost Billing</cbc:Name>
        <cbc:Telephone>+49 30 555 0400</cbc:Telephone>
        <cbc:ElectronicMail>billing@spreehost.example</cbc:ElectronicMail>
      </cac:Contact>
    </cac:Party>
  </cac:AccountingSupplierParty>
  <cac:AccountingCustomerParty>
    <cac:Party>
      <cbc:EndpointID schemeID="EM">accounts@meridianlabs.example</cbc:EndpointID>
      <cac:PostalAddress>
        <cbc:StreetName>Torstraße 140</cbc:StreetName>
        <cbc:CityName>Berlin</cbc:CityName>
        <cbc:PostalZone>10119</cbc:PostalZone>
        <cac:Country><cbc:IdentificationCode>DE</cbc:IdentificationCode></cac:Country>
      </cac:PostalAddress>
      <cac:PartyLegalEntity><cbc:RegistrationName>Meridian Labs GmbH</cbc:RegistrationName></cac:PartyLegalEntity>
    </cac:Party>
  </cac:AccountingCustomerParty>
  <cac:PaymentMeans>
    <cbc:PaymentMeansCode>58</cbc:PaymentMeansCode>
    <cbc:PaymentID>${INVOICE_NUMBER}</cbc:PaymentID>
    <cac:PayeeFinancialAccount>
      <cbc:ID>DE02120300000000202051</cbc:ID>
      <cbc:Name>Spreehost GmbH</cbc:Name>
      <cac:FinancialInstitutionBranch><cbc:ID>BYLADEM1001</cbc:ID></cac:FinancialInstitutionBranch>
    </cac:PayeeFinancialAccount>
  </cac:PaymentMeans>
  <cac:PaymentTerms><cbc:Note>Payable within 14 days without deduction.</cbc:Note></cac:PaymentTerms>
  <cac:TaxTotal>
    <cbc:TaxAmount currencyID="EUR">108.49</cbc:TaxAmount>
    <cac:TaxSubtotal>
      <cbc:TaxableAmount currencyID="EUR">571.00</cbc:TaxableAmount>
      <cbc:TaxAmount currencyID="EUR">108.49</cbc:TaxAmount>
      <cac:TaxCategory><cbc:ID>S</cbc:ID><cbc:Percent>19</cbc:Percent><cac:TaxScheme><cbc:ID>VAT</cbc:ID></cac:TaxScheme></cac:TaxCategory>
    </cac:TaxSubtotal>
  </cac:TaxTotal>
  <cac:LegalMonetaryTotal>
    <cbc:LineExtensionAmount currencyID="EUR">571.00</cbc:LineExtensionAmount>
    <cbc:TaxExclusiveAmount currencyID="EUR">571.00</cbc:TaxExclusiveAmount>
    <cbc:TaxInclusiveAmount currencyID="EUR">${INVOICE_TOTAL}</cbc:TaxInclusiveAmount>
    <cbc:PayableAmount currencyID="EUR">${INVOICE_TOTAL}</cbc:PayableAmount>
  </cac:LegalMonetaryTotal>${[
    line(1, 'Dedicated server DX-64', 'Beacon, eu-1 and eu-2', 2, '189.00', '378.00'),
    line(2, 'Managed PostgreSQL M', 'Primary with one replica', 1, '145.00', '145.00'),
    line(3, 'Backup storage 2 TB', 'Daily snapshots, 30 days kept', 1, '48.00', '48.00'),
  ].join('')}
</ubl:Invoice>
`;
}

/** Bytes of the XML, for the attachment size (the same every day). */
export const invoiceSize = (): number => new TextEncoder().encode(createSpreehostInvoiceXml()).length;

// A plugin for integration/tests/30-plugin-api-additions.spec.ts: it uses the
// plugin API of Bulwark 1.21 and records what it got in its storage, which
// the spec reads back from the page.
'use strict';

var api = null;

/** A one-page PDF saying `text` (ASCII only, so characters are bytes). */
function pdfBytes(text) {
  var stream = 'BT /F1 24 Tf 72 760 Td (' + text + ') Tj ET';
  var objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    '<< /Length ' + stream.length + ' >>\nstream\n' + stream + '\nendstream',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];
  var out = '%PDF-1.4\n';
  var offsets = [];
  objects.forEach(function (body, i) {
    offsets.push(out.length);
    out += (i + 1) + ' 0 obj\n' + body + '\nendobj\n';
  });
  var xref = out.length;
  out += 'xref\n0 ' + (objects.length + 1) + '\n0000000000 65535 f \n';
  offsets.forEach(function (offset) { out += ('0000000000' + offset).slice(-10) + ' 00000 n \n'; });
  out += 'trailer\n<< /Size ' + (objects.length + 1) + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF\n';
  var bytes = new Uint8Array(out.length);
  for (var i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i);
  return bytes;
}

async function remember(key, value) {
  var list = (await api.storage.get(key)) || [];
  list.push(value);
  await api.storage.set(key, list);
}

exports.activate = async function (host) {
  api = host;
  await api.ui.setActions('composer-header-actions', [
    { id: 'subject', label: 'Probe: case subject', icon: 'folder' },
  ]);
  await api.ui.setActions('reader-actions', [
    { id: 'reader-pdf', label: 'Probe: case PDF', icon: 'file' },
    { id: 'reader-print', label: 'Probe: print PDF', icon: 'printer' },
  ]);
};

exports.hooks = {
  async onAction(event) {
    var context = event.context || {};
    await remember('actions', { surface: event.surface, actionId: event.actionId, composerId: context.composerId || null, emailId: context.emailId || null });
    if (event.actionId === 'subject') {
      var snapshot = await api.composer.getSnapshot(context.composerId);
      await api.composer.setSubject(context.composerId, 'Akte 01/2026: ' + snapshot.subject);
    } else if (event.actionId === 'reader-pdf') {
      await api.ui.openFile({ content: pdfBytes('Akte 01/2026'), filename: 'Akte 01-2026', contentType: 'application/pdf' });
    } else if (event.actionId === 'reader-print') {
      await api.ui.print({ title: 'Alles drucken', pdf: pdfBytes('Alles drucken').buffer });
    }
  },
  async onBeforeEmailSend(email) {
    await remember('sendChecks', { composerId: email.composerId || null, subject: email.subject });
    return undefined;
  },
  async onTransformOutgoingEmail(email) {
    await remember('transforms', { composerId: email.composerId || null, keywords: email.keywords || null });
    // $seen is the system's and is dropped; the composer id can't be changed.
    return Object.assign({}, email, { keywords: ['akte-01-2026', '$flagged', '$seen'], composerId: 'forged' });
  },
  async onComposeFromLink(event) {
    await remember('links', event);
    await api.composer.setSubject(event.composerId, 'Link case ' + (event.params.case || '?'));
  },
};

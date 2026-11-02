/** Isolated preview: no scripts, navigation, external images, fonts or stylesheets. */
export function composePreviewDocument(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const link of template.content.querySelectorAll('a')) {
    link.removeAttribute('href');
    link.removeAttribute('target');
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'"><meta name="viewport" content="width=device-width,initial-scale=1"><style>
    body{margin:0;padding:20px;font:15px/1.5 Arial,sans-serif;color:#182230;background:#fff;overflow-wrap:anywhere}
    table{border-collapse:collapse;max-width:100%;width:100%}th,td{border:1px solid #d5d9e0;padding:8px;text-align:left}
    th{background:#f3f4f6}img{max-width:100%;height:auto}pre{white-space:pre-wrap;background:#f3f4f6;padding:12px;border-radius:6px}
    blockquote{border-left:3px solid #d5d9e0;margin-left:0;padding-left:16px;color:#596579}a{color:#5e50ac;text-decoration:underline}
  </style></head><body>${template.innerHTML}</body></html>`;
}

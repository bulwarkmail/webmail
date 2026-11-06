// Plain text as the rich editor's paragraphs. Its own module, so the plugin
// host API can turn text into HTML without loading the editor (ProseMirror).

/** Plain text a plugin sent, as editor HTML: one paragraph per line. */
export function textToEditorHtml(text: string): string {
  const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return text.replace(/\r\n?/g, '\n').split('\n').map((line) => `<p>${escape(line)}</p>`).join('');
}

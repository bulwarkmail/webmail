/** Preserve short file extensions while the stem truncates in a narrow chip. */
export function splitFileName(name: string): [stem: string, ext: string] {
  const dot = name.lastIndexOf('.');
  if (dot <= 0 || name.length - dot > 8) return [name, ''];
  return [name.slice(0, dot), name.slice(dot)];
}

export function AttachmentFilename({name}: {name: string}) {
  const [stem, ext] = splitFileName(name);
  return <span title={name} dir="auto" className="inline-flex min-w-0 max-w-[150px] md:max-w-[200px]">
    <span className="truncate">{stem}</span>{ext && <span className="shrink-0">{ext}</span>}
  </span>;
}

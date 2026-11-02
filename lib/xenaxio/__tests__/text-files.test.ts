import { describe, expect, it } from "vitest";
import {
  checkJson, codeLanguageOf, csvSeparator, isTextFile, linkifyHtml, parseCsv, splitLinks, TEXT_EDIT_MAX_BYTES, textContentType, textKindOf,
} from "../text-files";

describe("which files the editor opens (step 115, part 2)", () => {
  it("opens text files up to 1 MB, not Office, pictures or archives", () => {
    for (const name of ["Plan.md", "liste.txt", "daten.csv", "config.json", "seite.html", "app.ts", "deploy.yml", "server.log", "query.sql", "a.xml"]) {
      expect(isTextFile(name), name).toBe(true);
    }
    expect(isTextFile("gross.csv", TEXT_EDIT_MAX_BYTES + 1)).toBe(false);
    for (const name of ["bericht.docx", "foto.png", "archiv.zip", "rechnung.pdf", "ohne-endung"]) {
      expect(isTextFile(name), name).toBe(false);
    }
  });

  it("shows each kind its own way", () => {
    expect(textKindOf("a.md")).toBe("markdown");
    expect(textKindOf("a.csv")).toBe("csv");
    expect(textKindOf("a.tsv")).toBe("csv");
    expect(textKindOf("a.json")).toBe("json");
    expect(textKindOf("a.HTM")).toBe("html");
    expect(textKindOf("a.ts")).toBe("code");
    expect(textKindOf("a.yml")).toBe("code");
    expect(textKindOf("a.log")).toBe("plain");
    expect(textKindOf("a.txt")).toBe("plain");
    expect(codeLanguageOf("a.yml")).toBe("yaml");
    expect(codeLanguageOf("a.cjs")).toBe("javascript");
    expect(codeLanguageOf("a.toml")).toBe("ini");
    expect(codeLanguageOf("a.log")).toBeNull();
  });

  it("stores a new file with the type of its kind", () => {
    expect(textContentType("a.md")).toBe("text/markdown");
    expect(textContentType("a.csv")).toBe("text/csv");
    expect(textContentType("a.json")).toBe("application/json");
    expect(textContentType("a.html")).toBe("text/html");
    expect(textContentType("a.txt")).toBe("text/plain");
  });
});

describe("CSV", () => {
  it("finds the separator, ';' as in Germany too", () => {
    expect(csvSeparator("Name;Betrag\nA;1,50")).toBe(";");
    expect(csvSeparator("a,b,c\n1,2,3")).toBe(",");
    expect(csvSeparator("a\tb\n1\t2")).toBe("\t");
    expect(csvSeparator("a,b", "x.tsv")).toBe("\t");
  });

  it("reads quoted fields with separators, quotes and line breaks", () => {
    expect(parseCsv('Name;Notiz\r\n"Müller; Anna";"sagt ""hallo""\nund tschüss"\nB;', ";")).toEqual([
      ["Name", "Notiz"],
      ["Müller; Anna", 'sagt "hallo"\nund tschüss'],
      ["B", ""],
    ]);
    expect(parseCsv("", ",")).toEqual([]);
  });
});

describe("JSON", () => {
  it("formats good JSON and says the line of a mistake", () => {
    expect(checkJson('{"a":1,"b":[2]}')).toEqual({ ok: true, pretty: '{\n  "a": 1,\n  "b": [\n    2\n  ]\n}' });
    const broken = checkJson('{\n  "a": 1,\n  "b": \n}');
    expect(broken.ok).toBe(false);
    if (!broken.ok) expect(broken.line).toBe(4);
  });

  it("finds the place of typical mistakes", () => {
    const line = (t: string) => {
      const r = checkJson(t);
      return r.ok ? 0 : r.line;
    };
    expect(line('{\n  "a": 1\n  "b": 2\n}')).toBe(3); // missing comma
    expect(line("{\n  'a': 1\n}")).toBe(2); // single quotes
    expect(line('[1,\n2,\n]')).toBe(3); // trailing comma
    expect(line('{"a": tru}')).toBe(1);
    expect(line('{"a": 1} x')).toBe(1);
    expect(line('"open')).toBe(1);
    expect(line('[1, 2]')).toBe(0);
  });
});

describe("links", () => {
  it("finds addresses without the punctuation after them", () => {
    expect(splitLinks("Siehe https://xenaxio.com/a?b=1. Und (http://x.de)")).toEqual([
      { text: "Siehe " },
      { text: "https://xenaxio.com/a?b=1", href: "https://xenaxio.com/a?b=1" },
      { text: ". Und (" },
      { text: "http://x.de", href: "http://x.de" },
      { text: ")" },
    ]);
    expect(splitLinks("javascript:alert(1) ftp://x")).toEqual([{ text: "javascript:alert(1) ftp://x" }]);
  });

  it("turns addresses in highlighted code into links, touching only the text", () => {
    const html = '<span class="hljs-string">"https://api.example.com/v1"</span> &lt;b&gt;';
    const out = linkifyHtml(html);
    expect(out).toContain('<span class="hljs-string">"<a href="https://api.example.com/v1" target="_blank" rel="noopener noreferrer nofollow">https://api.example.com/v1</a>"</span>');
    expect(out).toContain("&lt;b&gt;");
  });
});

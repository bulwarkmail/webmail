import { describe, expect, it } from "vitest";
import { appOf, emailShareContent, messageHtml, mentionsUser, plainPreview, sharedEmailOf, textContent, toHtml } from "../format";

describe("composer text → message", () => {
  it("sends plain text without HTML", () => {
    expect(textContent("Hallo zusammen")).toEqual({ msgtype: "m.text", body: "Hallo zusammen", "m.mentions": {} });
  });

  it("formats Slack-style Markdown", () => {
    expect(toHtml("**fett** und _kursiv_ und ~~weg~~ und `code`")).toBe("<strong>fett</strong> und <em>kursiv</em> und <del>weg</del> und <code>code</code>");
    expect(toHtml("```\nconst a = 1 < 2;\n```")).toBe("<pre><code>const a = 1 &lt; 2;</code></pre>");
    expect(toHtml("> zitiert\n> zwei")).toBe("<blockquote>zitiert<br>zwei</blockquote>");
    expect(toHtml("- eins\n- zwei")).toBe("<ul><li>eins</li><li>zwei</li></ul>");
    expect(toHtml("1. eins\n2. zwei")).toBe("<ol><li>eins</li><li>zwei</li></ol>");
    expect(toHtml("siehe https://example.com/a_b_c.")).toBe('siehe <a href="https://example.com/a_b_c">https://example.com/a_b_c</a>.');
  });

  it("escapes HTML the user typed", () => {
    expect(toHtml("<b>nein</b> **ja**")).toBe("&lt;b&gt;nein&lt;/b&gt; <strong>ja</strong>");
  });

  it("links mentions and tells the server who is meant", () => {
    const c = textContent("@Anna Schmidt bitte ansehen, @channel", [{ userId: "@anna:acme.de", displayName: "Anna Schmidt" }, { userId: "@tom:acme.de", displayName: "Tom" }]);
    expect(c.formatted_body).toBe('<a href="https://matrix.to/#/%40anna%3Aacme.de">@Anna Schmidt</a> bitte ansehen, @channel');
    expect(c["m.mentions"]).toEqual({ user_ids: ["@anna:acme.de"], room: true });
  });
});

describe("showing messages", () => {
  it("sanitizes colleagues' HTML", () => {
    const html = messageHtml({ body: "x", format: "org.matrix.custom.html", formatted_body: '<b>ok</b><img src=x onerror=alert(1)><script>alert(1)</script><a href="javascript:alert(1)">link</a>' });
    expect(html).toContain("<b>ok</b>");
    expect(html).not.toMatch(/img|script|javascript|onerror/);
  });

  it("turns mentions into marked spans and opens links safely", () => {
    const html = messageHtml({ body: "x", format: "org.matrix.custom.html", formatted_body: '<a href="https://matrix.to/#/%40anna%3Aacme.de">Anna</a> <a href="https://example.com">e</a>' });
    expect(html).toContain('data-mention="@anna:acme.de"');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer nofollow"');
  });

  it("escapes and links plain bodies, drops thread fallbacks", () => {
    expect(messageHtml({ body: "<i>a</i>\nhttps://x.de" })).toBe('&lt;i&gt;a&lt;/i&gt;<br><a href="https://x.de" target="_blank" rel="noopener noreferrer nofollow">https://x.de</a>');
    expect(messageHtml({ body: "x", format: "org.matrix.custom.html", formatted_body: "<mx-reply>old</mx-reply>neu" })).toBe("neu");
  });

  it("knows mentions and previews", () => {
    expect(mentionsUser({ "m.mentions": { user_ids: ["@a:x"] } }, "@a:x")).toBe(true);
    expect(mentionsUser({ "m.mentions": { room: true } }, "@b:x")).toBe(true);
    expect(mentionsUser({ body: "@a" }, "@a:x")).toBe(false);
    expect(plainPreview({ msgtype: "m.image", body: "foto.png" })).toBe("🖼 foto.png");
  });
});

describe("integrations and shared e-mails (step 43, part D)", () => {
  it("labels only integration bots as apps", () => {
    expect(appOf({ "com.xenaxio.webhook": { name: "CI", icon: "🚨" } }, "@xenaxio.hook.0a1b2c3d4e5f:acme.de")).toEqual({ name: "CI", icon: "🚨" });
    expect(appOf({}, "@xenaxio.hook.0a1b2c3d4e5f:acme.de")).toEqual({ name: null, icon: null });
    // A colleague cannot pose as an app by adding the field.
    expect(appOf({ "com.xenaxio.webhook": { name: "Chef" } }, "@anna:acme.de")).toBeNull();
    expect(appOf({ "com.xenaxio.webhook": { icon: "<img src=x>" } }, "@xenaxio.hook.0a:acme.de")?.icon).toBeNull();
  });

  it("builds and reads the e-mail card, checking what others send", () => {
    const content = emailShareContent({ emailId: "Mabc", subject: "Angebot", from: "Max Müller", fromEmail: "max@kunde.de", preview: "Guten   Tag,\n anbei", date: "2026-10-27T09:00:00Z" }, " Bitte prüfen ", "(kein Betreff)");
    expect(content.body).toBe("Bitte prüfen\n\n📧 Angebot — Max Müller <max@kunde.de>\nGuten Tag, anbei");
    expect(sharedEmailOf(content)).toEqual({ emailId: "Mabc", subject: "Angebot", from: "Max Müller", fromEmail: "max@kunde.de", preview: "Guten Tag, anbei", date: "2026-10-27T09:00:00Z", note: "Bitte prüfen" });
    expect(sharedEmailOf({ "com.xenaxio.email": { emailId: "../../admin" } })).toBeNull();
    expect(sharedEmailOf({ "com.xenaxio.email": { emailId: "M1", subject: 5, date: "nope" } })).toMatchObject({ subject: "", date: null });
    expect(sharedEmailOf({ body: "x" })).toBeNull();
  });
});

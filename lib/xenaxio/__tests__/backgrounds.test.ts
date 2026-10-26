import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BACKGROUNDS, backgroundCss, effectiveBackground, findBackground } from "@/lib/xenaxio/backgrounds";
import de from "@/lib/xenaxio/messages-de.json";
import en from "@/lib/xenaxio/messages-en.json";

describe("step 42: backgrounds", () => {
  it("the person's own choice wins, else the company's, 'none' means none", () => {
    expect(effectiveBackground(null, null)).toBe(null);
    expect(effectiveBackground(null, "img-dunes")?.id).toBe("img-dunes");
    expect(effectiveBackground("grad-pink", "img-dunes")?.id).toBe("grad-pink");
    expect(effectiveBackground("none", "img-dunes")).toBe(null);
    // A code this client does not know (removed, or newer): as if not chosen.
    expect(effectiveBackground("img-gone", "img-dunes")?.id).toBe("img-dunes");
    expect(effectiveBackground("img-gone", "img-also-gone")).toBe(null);
    expect(findBackground(undefined)).toBe(null);
  });

  it("codes fit the platform's rule and are unique; 6 pictures and 6 gradients", () => {
    const ids = BACKGROUNDS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]{1,40}$/);
    expect(ids).not.toContain("none");
    expect(BACKGROUNDS.filter((b) => b.kind === "image")).toHaveLength(6);
    expect(BACKGROUNDS.filter((b) => b.kind === "gradient")).toHaveLength(6);
  });

  it("every picture exists in both modes with a preview, every name in German and English", () => {
    const dir = join(__dirname, "../../../public/xenaxio/backgrounds");
    for (const bg of BACKGROUNDS) {
      if (bg.kind === "image") {
        for (const file of [`${bg.id}-light.webp`, `${bg.id}-dark.webp`, `${bg.id}-light-thumb.webp`, `${bg.id}-dark-thumb.webp`, `${bg.id}-light-blur.webp`, `${bg.id}-dark-blur.webp`]) {
          expect(existsSync(join(dir, file)), file).toBe(true);
          expect(readFileSync(join(dir, file)).length, file).toBeLessThan(400 * 1024);
        }
      }
      expect((de.background.names as Record<string, string>)[bg.name], bg.name).toBeTruthy();
      expect((en.background.names as Record<string, string>)[bg.name], bg.name).toBeTruthy();
    }
  });

  it("the stylesheet sets the picture per mode and the accent only without a company colour", () => {
    const sea = findBackground("img-sea")!;
    const css = backgroundCss(sea, null);
    expect(css).toContain('html:not(.dark){--xenaxio-bg:url("/xenaxio/backgrounds/img-sea-light.webp")');
    expect(css).toContain('html.dark{--xenaxio-bg:url("/xenaxio/backgrounds/img-sea-dark.webp")');
    expect(css).toContain('--xenaxio-bg-soft:url("/xenaxio/backgrounds/img-sea-light-blur.webp")');
    expect(css).toContain(`--color-primary:${sea.accent.light};--color-primary-foreground:#ffffff;`);
    expect(css).toContain(`--color-primary:${sea.accent.dark};--color-primary-foreground:#111111;`);
    const branded = backgroundCss(sea, "#0a1b2c");
    expect(branded).not.toContain("--color-primary");
    // Something that is not a colour does not count as one.
    expect(backgroundCss(sea, "red;}")).toContain("--color-primary");
  });
});

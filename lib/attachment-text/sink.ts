// Where a reader writes its lines: it takes text until the read's character
// budget is used up, then says it is full, so a file whose few bytes stand
// for millions of characters (repeated cells, a long PDF) is never copied
// out in full before the final cut.

export class TextSink {
  private readonly lines: string[] = [];
  private used = 0;
  /** The budget is used up: whatever comes now is dropped, and the text is cut. */
  full = false;

  constructor(readonly budget: number) {}

  /** Adds one line (cut to what is left); false once the budget is used up. */
  line(text: string): boolean {
    if (this.full) return false;
    const room = this.budget - this.used;
    const kept = text.length > room ? text.slice(0, room) : text;
    this.lines.push(kept);
    this.used += kept.length + 1;
    if (kept.length < text.length || this.used >= this.budget) this.full = true;
    return !this.full;
  }

  text(): string {
    return this.lines.map((l) => l.replace(/[ \t]+$/g, '')).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  }
}

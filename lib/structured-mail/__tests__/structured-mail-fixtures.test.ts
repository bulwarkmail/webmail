/**
 * Every fixture through the whole pipeline (extract, normalise, validate,
 * merge, resolve zones), compared field by field with the reviewed cards in
 * expected-cards.json. Real samples are the 11 card-relevant mails from
 * local-data/schema examples, redacted; synthetic ones are self-written.
 * Doubtful fixtures must give no card at all.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { loadAirportZones, needsAirportZones, readStructuredMail, resolveCards, type StructuredCard } from '..';
import expected from './fixtures/expected-cards.json';
import real from './fixtures/real-mails.json';
import { syntheticMails, type MailFixture } from './fixtures/synthetic-mails';

const fixtures: MailFixture[] = [...(real as MailFixture[]), ...syntheticMails];
const expectedById = expected as Record<string, StructuredCard[]>;

async function cardsOf(fixture: MailFixture): Promise<StructuredCard[]> {
  const cards = readStructuredMail(fixture.html, { mailDate: new Date(fixture.mailDate) });
  return needsAirportZones(cards) ? resolveCards(cards, await loadAirportZones()) : resolveCards(cards);
}

type Score = { mails: number; found: number; correct: number; wrong: number; none: number };
const scores = new Map<string, Score>();

describe('structured mail fixtures', () => {
  it('has an expectation for every fixture and no stray ones', () => {
    expect(Object.keys(expectedById).sort()).toEqual(fixtures.map((f) => f.id).sort());
  });

  it.each(fixtures.map((f) => [f.id, f] as const))('%s', async (_id, fixture) => {
    const cards = await cardsOf(fixture);
    const want = expectedById[fixture.id];
    const score = scores.get(fixture.sender) ?? { mails: 0, found: 0, correct: 0, wrong: 0, none: 0 };
    score.mails++;
    const equal = JSON.stringify(cards) === JSON.stringify(want);
    if (cards.length === 0) score.none++;
    else {
      score.found++;
      if (equal) score.correct++;
      else score.wrong++;
    }
    scores.set(fixture.sender, score);
    expect(cards).toEqual(want);
  });

  it('gives nothing for every doubtful fixture', async () => {
    for (const fixture of fixtures.filter((f) => f.id.startsWith('doubtful-'))) {
      expect(await cardsOf(fixture), fixture.id).toEqual([]);
    }
  });

  afterAll(() => {
    const rows = [...scores.entries()].sort(([a], [b]) => a.localeCompare(b));
    const lines = rows.map(([sender, s]) => `${sender.padEnd(28)} mails ${s.mails}  found ${s.found}  correct ${s.correct}  wrong ${s.wrong}  none ${s.none}`);
    const total = rows.reduce((t, [, s]) => ({ found: t.found + s.found, correct: t.correct + s.correct, wrong: t.wrong + s.wrong }), { found: 0, correct: 0, wrong: 0 });
    console.log(`structured mail score per sender\n${lines.join('\n')}\ntotal found ${total.found}, correct ${total.correct}, wrong ${total.wrong}`);
  });
});

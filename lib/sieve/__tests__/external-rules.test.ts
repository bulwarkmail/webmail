import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseScript } from '../parser';
import { generateScript } from '../generator';
import type { FilterRule } from '@/lib/jmap/sieve-types';

function makeBulwarkRule(overrides: Partial<FilterRule> = {}): FilterRule {
  return {
    id: 'bw-1',
    name: 'Bulwark Rule',
    enabled: true,
    matchType: 'all',
    conditions: [{ field: 'from', comparator: 'contains', value: 'test@example.com' }],
    actions: [{ type: 'move', value: 'Archive' }],
    stopProcessing: false,
    ...overrides,
  };
}

describe('external rule preservation (issue #201)', () => {
  describe('parser - external rule recognition', () => {
    it('parses a Roundcube-style rule with "# rule:[Name]" comment', () => {
      const script = `require ["fileinto"];\n\n# rule:[Archive Newsletters]\nif header :contains "List-Id" "news" {\n    fileinto "Newsletters";\n}\n`;
      const result = parseScript(script);

      expect(result.isOpaque).toBe(false);
      expect(result.rules).toHaveLength(1);
      const rule = result.rules[0];
      expect(rule.origin).toBe('external');
      expect(rule.originLabel).toBe('Roundcube');
      expect(rule.name).toBe('Archive Newsletters');
      expect(rule.conditions[0]).toMatchObject({
        field: 'header',
        comparator: 'contains',
        value: 'news',
        headerName: 'List-Id',
      });
      expect(rule.actions[0]).toEqual({ type: 'move', value: 'Newsletters' });
    });

    it('labels rules near a Nextcloud marker comment', () => {
      const script = `require ["fileinto"];\n\n# Nextcloud Mail - begin\nif header :contains "Subject" "invoice" {\n    fileinto "Finance";\n}\n# Nextcloud Mail - end\n`;
      const result = parseScript(script);
      expect(result.rules[0].originLabel).toBe('Nextcloud');
    });

    it('falls back to "External" label when no known marker is present', () => {
      const script = `require ["fileinto"];\n\nif header :contains "From" "boss@corp.com" {\n    fileinto "Important";\n}\n`;
      const result = parseScript(script);
      expect(result.rules[0].originLabel).toBe('External');
    });

    it('parses anyof/allof conditions in external rules', () => {
      const script = `require ["fileinto"];\n\nif anyof(header :contains "From" "a@x.com", header :contains "From" "b@x.com") {\n    fileinto "VIP";\n}\n`;
      const result = parseScript(script);
      expect(result.rules[0].matchType).toBe('any');
      expect(result.rules[0].conditions).toHaveLength(2);
    });

    it('parses negated conditions (not header :is)', () => {
      const script = `if not header :is "From" "spam@x.com" {\n    keep;\n}\n`;
      const result = parseScript(script);
      expect(result.rules[0].conditions[0]).toMatchObject({
        field: 'from',
        comparator: 'not_is',
        value: 'spam@x.com',
      });
    });

    it('marks unrecognized blocks as opaque but preserves their raw text', () => {
      const script = `require ["relational"];\n\nif header :value "ge" :comparator "i;ascii-numeric" "X-Priority" ["3"] {\n    keep;\n}\n`;
      const result = parseScript(script);
      expect(result.isOpaque).toBe(false);
      const rule = result.rules[0];
      expect(rule.origin).toBe('opaque');
      expect(rule.rawBlock).toContain('if header :value');
    });

    it('collects all external require tokens', () => {
      const script = `require ["fileinto", "imap4flags", "body"];\n\nif header :is "Subject" "hi" { fileinto "A"; }\n`;
      const result = parseScript(script);
      expect(result.externalRequires).toEqual(expect.arrayContaining(['fileinto', 'imap4flags', 'body']));
    });
  });

  describe('parser - mixed Bulwark + external', () => {
    it('returns Bulwark rules from metadata and external rules from the rest', () => {
      const bulwark = [makeBulwarkRule({ name: 'Bulwark A' })];
      const bulwarkScript = generateScript(bulwark);
      const mixedScript = `${bulwarkScript}\n# External appended by Nextcloud\nif header :contains "List-Id" "devs" {\n    fileinto "Dev";\n}\n`;

      const result = parseScript(mixedScript);
      expect(result.isOpaque).toBe(false);
      expect(result.rules.length).toBeGreaterThanOrEqual(2);

      const bulwarkParsed = result.rules.filter(r => !r.origin || r.origin === 'bulwark');
      const externalParsed = result.rules.filter(r => r.origin === 'external');
      expect(bulwarkParsed).toHaveLength(1);
      expect(bulwarkParsed[0].name).toBe('Bulwark A');
      expect(externalParsed).toHaveLength(1);
      expect(externalParsed[0].originLabel).toBe('Nextcloud');
    });

    it('does not return Bulwark-emitted if-blocks as external duplicates', () => {
      const bulwark = [makeBulwarkRule({ name: 'My Bulwark Rule' })];
      const script = generateScript(bulwark);
      const result = parseScript(script);

      // Only the metadata-sourced rule, no duplicate "external" entry.
      expect(result.rules).toHaveLength(1);
      expect(result.rules[0].origin).toBeUndefined();
    });
  });

  describe('generator - external splice', () => {
    it('appends external rawBlocks verbatim after Bulwark-managed output', () => {
      const externalRule: FilterRule = {
        id: 'ext-0',
        name: 'External',
        enabled: true,
        matchType: 'all',
        conditions: [{ field: 'header', comparator: 'contains', value: 'x', headerName: 'List-Id' }],
        actions: [{ type: 'move', value: 'Lists' }],
        stopProcessing: false,
        origin: 'external',
        originLabel: 'Nextcloud',
        rawBlock: '# Nextcloud Mail\nif header :contains "List-Id" "x" {\n    fileinto "Lists";\n}\n',
      };
      const rules: FilterRule[] = [makeBulwarkRule(), externalRule];
      const script = generateScript(rules);

      expect(script).toContain('# Rule: Bulwark Rule');
      expect(script).toContain('# Nextcloud Mail');
      expect(script).toContain('# --- External rules (managed outside Bulwark) ---');
      const bulwarkIdx = script.indexOf('# Rule: Bulwark Rule');
      const externalIdx = script.indexOf('# Nextcloud Mail');
      expect(bulwarkIdx).toBeLessThan(externalIdx);
    });

    it('unions external requires into the top-level require line', () => {
      const script = generateScript([makeBulwarkRule()], undefined, {
        externalRequires: ['fileinto', 'imap4flags', 'body'],
      });
      const requireLine = script.split('\n').find(l => l.startsWith('require'))!;
      expect(requireLine).toContain('"fileinto"');
      expect(requireLine).toContain('"imap4flags"');
      expect(requireLine).toContain('"body"');
    });

    it('strips origin/rawBlock/originLabel from Bulwark rules when writing metadata', () => {
      const bulwarkWithJunk: FilterRule = {
        ...makeBulwarkRule(),
        origin: 'bulwark',
        originLabel: 'shouldnotbehere',
        rawBlock: 'shouldnotbehere',
      };
      const script = generateScript([bulwarkWithJunk]);
      const match = script.match(/@metadata:begin\n(.*)\n@metadata:end/);
      const metadata = JSON.parse(match![1]);
      expect(metadata.rules[0]).not.toHaveProperty('origin');
      expect(metadata.rules[0]).not.toHaveProperty('originLabel');
      expect(metadata.rules[0]).not.toHaveProperty('rawBlock');
    });

    it('never writes external rules into metadata', () => {
      const ext: FilterRule = {
        id: 'ext-0',
        name: 'Ext',
        enabled: true,
        matchType: 'all',
        conditions: [{ field: 'from', comparator: 'is', value: 'x@y' }],
        actions: [{ type: 'keep' }],
        stopProcessing: false,
        origin: 'external',
        rawBlock: '# ext\nif header :is "From" "x@y" { keep; }',
      };
      const script = generateScript([makeBulwarkRule(), ext]);
      const match = script.match(/@metadata:begin\n(.*)\n@metadata:end/);
      const metadata = JSON.parse(match![1]);
      expect(metadata.rules).toHaveLength(1);
      expect(metadata.rules[0].name).toBe('Bulwark Rule');
    });
  });

  describe('fixture: mixed-origins.sieve', () => {
    const fixture = readFileSync(
      join(__dirname, 'fixtures', 'mixed-origins.sieve'),
      'utf-8',
    );

    it('identifies Bulwark, Roundcube, Nextcloud, External, and opaque rules', () => {
      const result = parseScript(fixture);

      expect(result.isOpaque).toBe(false);
      expect(result.vacation).toBeUndefined();

      const byOrigin = {
        bulwark: result.rules.filter(r => !r.origin || r.origin === 'bulwark'),
        external: result.rules.filter(r => r.origin === 'external'),
        opaque: result.rules.filter(r => r.origin === 'opaque'),
      };

      expect(byOrigin.bulwark).toHaveLength(2);
      expect(byOrigin.external.length).toBeGreaterThanOrEqual(3);
      expect(byOrigin.opaque).toHaveLength(1);

      const labels = byOrigin.external.map(r => r.originLabel);
      expect(labels).toContain('Roundcube');
      expect(labels).toContain('Nextcloud');
      expect(labels).toContain('External');

      const opaqueRule = byOrigin.opaque[0];
      expect(opaqueRule.rawBlock).toContain(':comparator "i;ascii-numeric"');
    });

    it('preserves unknown-Sieve content through save round-trip', () => {
      const parsed = parseScript(fixture);
      const regenerated = generateScript(parsed.rules, parsed.vacation, {
        externalRequires: parsed.externalRequires,
      });

      // The unparseable construct must appear verbatim in the regenerated script.
      expect(regenerated).toContain(':comparator "i;ascii-numeric"');
      // Require tokens from the external content are preserved.
      expect(regenerated).toContain('"relational"');
      // Bulwark rules are still present.
      expect(regenerated).toContain('# Rule: Archive newsletters');
    });
  });

  describe('round-trip', () => {
    it('preserves external rules through parse → generate → parse', () => {
      const initial = `require ["fileinto", "imap4flags"];\n\n# rule:[VIP]\nif header :contains "From" "boss@company.com" {\n    fileinto "VIP";\n    addflag "\\\\Flagged";\n}\n\n# Nextcloud Mail - begin\nif header :contains "Subject" "invoice" {\n    fileinto "Finance";\n}\n# Nextcloud Mail - end\n`;

      const firstParse = parseScript(initial);
      expect(firstParse.rules).toHaveLength(2);

      const regenerated = generateScript(firstParse.rules, firstParse.vacation, {
        externalRequires: firstParse.externalRequires,
      });
      const secondParse = parseScript(regenerated);

      expect(secondParse.rules).toHaveLength(2);
      const names = secondParse.rules.map(r => r.name).sort();
      expect(names).toContain('VIP');
    });

    it('does not destroy external rules when Bulwark regenerates after an edit', () => {
      const initial = `${generateScript([makeBulwarkRule({ name: 'Mine' })])}\n# rule:[Untouchable]\nif header :is "X-Spam" "yes" {\n    discard;\n}\n`;

      const parsed = parseScript(initial);
      const externalBefore = parsed.rules.filter(r => r.origin === 'external');
      expect(externalBefore).toHaveLength(1);

      // Simulate a user edit - update the Bulwark rule name
      const edited = parsed.rules.map(r => (r.origin === 'external' || r.origin === 'opaque' ? r : { ...r, name: 'Mine (edited)' }));
      const regenerated = generateScript(edited, parsed.vacation, { externalRequires: parsed.externalRequires });
      const reparsed = parseScript(regenerated);

      const externalAfter = reparsed.rules.filter(r => r.origin === 'external');
      expect(externalAfter).toHaveLength(1);
      expect(externalAfter[0].name).toBe('Untouchable');
      expect(externalAfter[0].conditions[0]).toMatchObject({ field: 'header', headerName: 'X-Spam' });
    });
  });

  describe('Nextcloud Mail marker regions', () => {
    const NEXTCLOUD_MARKER = "### Nextcloud Mail: Filters ### DON'T EDIT ###";

    const nextcloudScript = [
      NEXTCLOUD_MARKER,
      'require ["imap4flags", "fileinto"];',
      NEXTCLOUD_MARKER,
      '',
      NEXTCLOUD_MARKER,
      '# FILTER: [{"name":"Wetterwarnungen"}]',
      'if header :contains "From" "weather@x.com" {',
      '    fileinto "Weather";',
      '}',
      '',
      '# PayPal',
      'if header :contains "From" "paypal.de" {',
      '    addflag "$paypal";',
      '}',
      NEXTCLOUD_MARKER,
      '',
    ].join('\n');

    it('collapses a Nextcloud marker-pair region into one opaque rule labeled "Nextcloud"', () => {
      const result = parseScript(nextcloudScript);
      const nextcloud = result.rules.filter(r => r.originLabel === 'Nextcloud');
      expect(nextcloud).toHaveLength(1);
      expect(nextcloud[0].origin).toBe('opaque');
      // Every marker that wrapped actual rule content survives in the rawBlock.
      const markerCount = (nextcloud[0].rawBlock || '').split(NEXTCLOUD_MARKER).length - 1;
      expect(markerCount).toBe(2);
      // Inner if-blocks are not exposed as separate external rules.
      expect(result.rules.filter(r => r.originLabel === 'External')).toHaveLength(0);
    });

    it('merges require tokens from inside Nextcloud regions into externalRequires', () => {
      const result = parseScript(nextcloudScript);
      expect(result.externalRequires).toEqual(expect.arrayContaining(['imap4flags', 'fileinto']));
    });

    it('drops require-only Nextcloud regions (no separate opaque rule for them)', () => {
      const script = [
        NEXTCLOUD_MARKER,
        'require ["fileinto"];',
        NEXTCLOUD_MARKER,
        '',
      ].join('\n');
      const result = parseScript(script);
      expect(result.rules).toHaveLength(0);
      expect(result.externalRequires).toContain('fileinto');
    });

    it('round-trips a Nextcloud region verbatim through parse → generate → parse', () => {
      const bulwark = makeBulwarkRule({ name: 'Test' });
      const initial = `${generateScript([bulwark])}\n${nextcloudScript}`;

      const parsed = parseScript(initial);
      const regenerated = generateScript(parsed.rules, parsed.vacation, {
        externalRequires: parsed.externalRequires,
      });

      // Both wrapping markers remain, in the right positions.
      const firstMarker = regenerated.indexOf(NEXTCLOUD_MARKER);
      const lastMarker = regenerated.lastIndexOf(NEXTCLOUD_MARKER);
      expect(firstMarker).toBeGreaterThanOrEqual(0);
      expect(lastMarker).toBeGreaterThan(firstMarker);
      expect(regenerated).toContain('# FILTER: [{"name":"Wetterwarnungen"}]');
      expect(regenerated).toContain('# PayPal');

      const reparsed = parseScript(regenerated);
      expect(reparsed.rules.filter(r => r.originLabel === 'Nextcloud')).toHaveLength(1);
      expect(reparsed.rules.filter(r => r.originLabel === 'External')).toHaveLength(0);
    });

    it('does not emit duplicate "External rules" headers across repeated saves', () => {
      const bulwark = makeBulwarkRule({ name: 'Test' });
      const initial = `${generateScript([bulwark])}\n${nextcloudScript}`;

      let script = initial;
      for (let i = 0; i < 3; i++) {
        const parsed = parseScript(script);
        script = generateScript(parsed.rules, parsed.vacation, {
          externalRequires: parsed.externalRequires,
        });
      }

      const headerCount = (script.match(/# --- External rules \(managed outside Bulwark\) ---/g) || []).length;
      expect(headerCount).toBe(1);
    });
  });
});

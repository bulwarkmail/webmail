// The list of top-level domains in lib/top-level-domains.ts is embedded and dated. This test keeps
// it current: it reads the ICANN section of the public suffix data in the installed tldts (a test
// dependency only) and fails, naming the labels, when tldts knows a top-level domain the list does
// not have. The command that regenerates the list is in the module's header.
import { createRequire } from 'node:module';
import { domainToASCII } from 'node:url';
import { parse } from 'tldts';
import { describe, expect, it } from 'vitest';
import { RESERVED_TOP_LEVEL_DOMAINS, TOP_LEVEL_DOMAINS } from '../top-level-domains';

/** tldts's flat suffix trie: edges of each node in edgeStart, their labels one after another in labelText. */
interface SuffixTrie {
  nodeFlags: ArrayLike<number>;
  edgeStart: ArrayLike<number>;
  edgeLength: ArrayLike<number>;
  edgeChild: ArrayLike<number>;
  labelText: string;
  rulesRoot: number;
}
const ICANN = 1;

/** Every top-level label of an ICANN rule in the trie, in ASCII form. */
function icannTopLevelLabels(trie: SuffixTrie): string[] {
  const offsets: number[] = [];
  for (let edge = 0, offset = 0; edge < trie.edgeLength.length; edge += 1) {
    offsets[edge] = offset;
    offset += trie.edgeLength[edge];
  }
  const hasIcannRule = (node: number): boolean => {
    if ((trie.nodeFlags[node] & ICANN) !== 0) return true;
    for (let edge = trie.edgeStart[node]; edge < trie.edgeStart[node + 1]; edge += 1) {
      if (hasIcannRule(trie.edgeChild[edge])) return true;
    }
    return false;
  };
  const labels = new Set<string>();
  for (let edge = trie.edgeStart[trie.rulesRoot]; edge < trie.edgeStart[trie.rulesRoot + 1]; edge += 1) {
    if (hasIcannRule(trie.edgeChild[edge])) labels.add(domainToASCII(trie.labelText.slice(offsets[edge], offsets[edge] + trie.edgeLength[edge])));
  }
  return [...labels];
}

const trie = createRequire(import.meta.url)('tldts/dist/cjs/src/data/trie.js') as SuffixTrie;
const installed = icannTopLevelLabels(trie);
const delegated = [...TOP_LEVEL_DOMAINS].filter((label) => !RESERVED_TOP_LEVEL_DOMAINS.includes(label));

describe('the embedded list of top-level domains', () => {
  it('reads the installed tldts data (the trie walk finds the known top-level domains)', () => {
    expect(installed.length).toBeGreaterThan(1000);
    for (const label of ['com', 'de', 'uk', 'shop', 'xn--p1ai']) expect(installed).toContain(label);
    expect(parse('x.co.uk').publicSuffix).toBe('co.uk');
  });

  it('holds every top-level domain the installed tldts knows in its ICANN section', () => {
    // When this fails after a tldts update, regenerate the list with the command in lib/top-level-domains.ts.
    expect(installed.filter((label) => !TOP_LEVEL_DOMAINS.has(label))).toEqual([]);
  });

  it('holds nothing tldts does not know as an ICANN top-level domain, besides the reserved names', () => {
    const known = new Set(installed);
    expect(delegated.filter((label) => !known.has(label))).toEqual([]);
  });

  it('holds the reserved names', () => {
    for (const label of ['example', 'test', 'invalid', 'localhost', 'local', 'internal', 'lan', 'home', 'corp']) {
      expect(TOP_LEVEL_DOMAINS.has(label), label).toBe(true);
    }
  });

  it('holds labels in ASCII lower case: no upper case, no dots, no empty entry', () => {
    expect([...TOP_LEVEL_DOMAINS].filter((label) => !/^[a-z0-9-]+$/.test(label))).toEqual([]);
    expect(TOP_LEVEL_DOMAINS.has('')).toBe(false);
  });

  it('holds the internationalised ones in their xn-- form', () => {
    expect(TOP_LEVEL_DOMAINS.has('xn--p1ai')).toBe(true);
    expect(TOP_LEVEL_DOMAINS.has('xn--fiqs8s')).toBe(true);
    expect(delegated.filter((label) => label.startsWith('xn--')).length).toBeGreaterThan(100);
  });

  it('is not cut short', () => {
    expect(TOP_LEVEL_DOMAINS.size).toBeGreaterThan(1400);
    expect(TOP_LEVEL_DOMAINS.size).toBeLessThan(2500);
  });
});

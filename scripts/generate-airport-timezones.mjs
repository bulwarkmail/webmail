#!/usr/bin/env node
/**
 * Generate the IATA airport code → IANA time zone table that flight cards
 * use (lib/structured-mail/data/airport-timezones.json).
 *
 *   node scripts/generate-airport-timezones.mjs [path/to/airports.json]
 *
 * Booking markup gives flight times with a UTC offset only; the calendar
 * wants the airport's IANA zone, so the event stays right across DST changes.
 * The source is mwgg/Airports (MIT, see NOTICE), pinned to one commit and
 * checked against its SHA-256. Pass a local copy of airports.json to skip the
 * download. The output is committed; rerun only when moving the pin.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const COMMIT = 'a89e4e0dda9d9878337e2da190ebe1ef1d6af705';
const SHA256 = 'a7754cbe722ea21f0f9ab1ef07f4f07ee1e85b9cc99191ebde0b49fabb3c149a';
const SOURCE = `https://raw.githubusercontent.com/mwgg/Airports/${COMMIT}/airports.json`;

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.resolve(here, '..', 'lib', 'structured-mail', 'data', 'airport-timezones.json');

async function readSource() {
  if (process.argv[2]) return fs.readFileSync(process.argv[2]);
  const response = await fetch(SOURCE);
  if (!response.ok) throw new Error(`GET ${SOURCE}: HTTP ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
}

function isValidZone(zone) {
  try {
    new Intl.DateTimeFormat('en', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

const raw = await readSource();
const digest = crypto.createHash('sha256').update(raw).digest('hex');
if (digest !== SHA256) throw new Error(`airports.json SHA-256 ${digest}, expected ${SHA256}`);

const byCode = new Map();
let conflicts = 0;
for (const airport of Object.values(JSON.parse(raw.toString('utf8')))) {
  const code = typeof airport.iata === 'string' ? airport.iata.trim().toUpperCase() : '';
  if (!/^[A-Z]{3}$/.test(code) || !airport.tz || !isValidZone(airport.tz)) continue;
  const known = byCode.get(code);
  if (known && known !== airport.tz) {
    // Two airports claim one code with different zones: drop the code, a
    // wrong zone is worse than the offset fallback.
    byCode.set(code, null);
    conflicts++;
    continue;
  }
  if (known === undefined) byCode.set(code, airport.tz);
}

const zones = [...new Set([...byCode.values()].filter(Boolean))].sort();
const zoneIndex = new Map(zones.map((zone, index) => [zone, index]));
const airports = {};
for (const code of [...byCode.keys()].sort()) {
  const zone = byCode.get(code);
  if (zone) airports[code] = zoneIndex.get(zone);
}

const table = { source: `mwgg/Airports@${COMMIT.slice(0, 12)} (MIT)`, zones, airports };
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, JSON.stringify(table) + '\n');
console.log(`${Object.keys(airports).length} airports, ${zones.length} zones, ${conflicts} conflicting codes dropped → ${path.relative(process.cwd(), OUT)}`);

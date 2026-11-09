import { describe, expect, it } from 'vitest';
import { parseLenientJson } from '../json-repair';

const A = { '@type': 'FlightReservation', reservationNumber: 'A1' };
const B = { '@type': 'FlightReservation', reservationNumber: 'B2' };

describe('parseLenientJson', () => {
  it('parses valid JSON unchanged', () => {
    expect(parseLenientJson(JSON.stringify([A, B]))).toEqual([A, B]);
  });

  it('adds the commas Eurowings leaves out between array objects', () => {
    expect(parseLenientJson(`[${JSON.stringify(A)}\n${JSON.stringify(B)}]`)).toEqual([A, B]);
    expect(parseLenientJson(`[${JSON.stringify(A)}${JSON.stringify(B)}]`)).toEqual([A, B]);
  });

  it('adds the brackets Volotea leaves out, with or without commas', () => {
    expect(parseLenientJson(`${JSON.stringify(A)},\n${JSON.stringify(B)}`)).toEqual([A, B]);
    expect(parseLenientJson(`${JSON.stringify(A)}\n${JSON.stringify(B)}`)).toEqual([A, B]);
  });

  it('drops the trailing commas Eventbrite writes', () => {
    expect(parseLenientJson('{"@type": "EventReservation", "reservationNumber": "E1", }')).toEqual({ '@type': 'EventReservation', reservationNumber: 'E1' });
    expect(parseLenientJson('[{"a": [1, 2, ], }, ]')).toEqual([{ a: [1, 2] }]);
  });

  it('decodes the XML entities Airbnb encodes its JSON with', () => {
    const encoded = JSON.stringify(A).replace(/"/g, '&quot;');
    expect(parseLenientJson(encoded)).toEqual(A);
    expect(parseLenientJson('{&quot;name&quot;: &quot;Caf&#233; &amp; Bar&quot;}')).toEqual({ name: 'Café & Bar' });
  });

  it('strips comment and CDATA wrappers and escapes raw newlines in strings', () => {
    expect(parseLenientJson(`<!--\n${JSON.stringify(A)}\n-->`)).toEqual(A);
    expect(parseLenientJson(`<![CDATA[${JSON.stringify(A)}]]>`)).toEqual(A);
    expect(parseLenientJson('{"name": "two\nlines"}')).toEqual({ name: 'two\nlines' });
  });

  it('leaves commas and braces inside strings alone', () => {
    expect(parseLenientJson('{"name": "a, } { b", }')).toEqual({ name: 'a, } { b' });
  });

  it('gives up on input it cannot repair', () => {
    expect(parseLenientJson('{"a": ')).toBeUndefined();
    expect(parseLenientJson('not json at all')).toBeUndefined();
    expect(parseLenientJson('')).toBeUndefined();
    expect(parseLenientJson(`[${'x'.repeat(200_001)}]`)).toBeUndefined();
  });
});

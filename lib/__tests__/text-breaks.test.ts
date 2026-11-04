import { describe, expect, it } from 'vitest';
import { addressBreakPieces } from '../text-breaks';

describe('addressBreakPieces', () => {
  it('breaks after the @ and before dots', () => {
    expect(addressBreakPieces('dana.with.long@subdomain.example.net')).toEqual(['dana', '.with', '.long@', 'subdomain', '.example.net']);
  });

  it('breaks after + - and _', () => {
    expect(addressBreakPieces('bounces+318-0dcc_x@em.example.org')).toEqual(['bounces+', '318-', '0dcc_', 'x@em', '.example.org']);
  });

  it('keeps short runs whole and loses no character', () => {
    const text = 'a.b.c@d.io';
    const pieces = addressBreakPieces(text);
    expect(pieces.join('')).toBe(text);
    expect(pieces.every((piece) => piece.length >= 3)).toBe(true);
  });

  it('never leaves the top-level domain alone on a line', () => {
    expect(addressBreakPieces('someone@notifications.mail.example-service.example.net').at(-1)).toBe('.example.net');
  });

  it('leaves a name without break points as one piece', () => {
    expect(addressBreakPieces('Anthropic')).toEqual(['Anthropic']);
  });
});

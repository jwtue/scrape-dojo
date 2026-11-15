import { describe, it, expect } from 'vitest';

import { describeValue } from './describe-value';

describe('describeValue', () => {
  it('gives a string back unchanged', () => {
    expect(describeValue('angemeldet, 18 Jahre im Filter')).toBe(
      'angemeldet, 18 Jahre im Filter',
    );
  });

  it('describes an object without a prototype, as jsonata returns it', () => {
    const vonJsonata: any = Object.create(null);
    vonJsonata.totalPages = 3;
    vonJsonata.effectiveStartPage = 1;

    // Vorbedingung: ohne Hilfe wirft genau das den Lauf ab.
    expect(() => `${vonJsonata}`).toThrow('Cannot convert object to primitive');

    expect(describeValue(vonJsonata)).toBe(
      '{"totalPages":3,"effectiveStartPage":1}',
    );
  });

  it('describes plain values', () => {
    expect(describeValue(42)).toBe('42');
    expect(describeValue(false)).toBe('false');
    expect(describeValue(null)).toBe('null');
    expect(describeValue(undefined)).toBe('undefined');
    expect(describeValue(['year-2026', 'year-2025'])).toBe(
      '["year-2026","year-2025"]',
    );
  });

  it('survives a circular structure', () => {
    const rund: any = { name: 'a' };
    rund.self = rund;

    expect(describeValue(rund)).toBe('[object Object]');
  });

  it('survives a BigInt and a throwing toJSON', () => {
    expect(describeValue(BigInt(7))).toBe('7');
    expect(
      describeValue({
        toJSON() {
          throw new Error('nope');
        },
      }),
    ).toBe('[object Object]');
  });

  it('never throws, whatever it gets', () => {
    const boshaft = Object.create(null);

    expect(() => describeValue(boshaft)).not.toThrow();
    expect(() => describeValue(Symbol('x'))).not.toThrow();
    expect(() => describeValue(() => undefined)).not.toThrow();
  });
});

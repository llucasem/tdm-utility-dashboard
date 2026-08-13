import { describe, it, expect } from 'vitest';
import { normalizeAddress, normalizeUnit, addressesMatch } from '../lib/address-normalize.js';

describe('normalizeAddress()', () => {
  it('drops city/state/zip after first comma', () => {
    expect(normalizeAddress('175 W 107th St, New York, NY 10025')).toBe('175 w 107th st');
  });

  it('handles missing street suffix as same as with suffix', () => {
    expect(normalizeAddress('175 W 107th, NY 10025')).toBe('175 w 107th');
    expect(normalizeAddress('175 W 107th St, NY 10025')).toBe('175 w 107th st');
  });

  it('collapses Street → St', () => {
    expect(normalizeAddress('439 West 51st Street, NY')).toBe('439 w 51st st');
    expect(normalizeAddress('439 W 51st St, NY')).toBe('439 w 51st st');
  });

  it('collapses Avenue → Ave', () => {
    expect(normalizeAddress('3221 Carter Avenue')).toBe('3221 carter ave');
    expect(normalizeAddress('3221 Carter Ave, Marina Del Rey, CA 90292')).toBe('3221 carter ave');
  });

  it('collapses Boulevard → Blvd', () => {
    expect(normalizeAddress('4750 Lincoln Boulevard')).toBe('4750 lincoln blvd');
    expect(normalizeAddress('4750 Lincoln Blvd, Marina Del Rey')).toBe('4750 lincoln blvd');
  });

  it('handles trailing dots', () => {
    expect(normalizeAddress('472 9th Ave.')).toBe('472 9th ave');
    expect(normalizeAddress('472 9th Ave')).toBe('472 9th ave');
  });

  it('returns empty for null/undefined', () => {
    expect(normalizeAddress(null)).toBe('');
    expect(normalizeAddress(undefined)).toBe('');
    expect(normalizeAddress('')).toBe('');
  });
});

describe('normalizeUnit()', () => {
  it('strips Apt prefix', () => {
    expect(normalizeUnit('Apt 3')).toBe('3');
    expect(normalizeUnit('apt. 3B')).toBe('3b');
  });

  it('strips # prefix', () => {
    expect(normalizeUnit('#3')).toBe('3');
    expect(normalizeUnit('# 3A')).toBe('3a');
  });

  it('strips Unit prefix', () => {
    expect(normalizeUnit('Unit 5')).toBe('5');
  });

  it('passes plain units', () => {
    expect(normalizeUnit('501')).toBe('501');
    expect(normalizeUnit('3D')).toBe('3d');
  });

  it('returns empty for nullish', () => {
    expect(normalizeUnit(null)).toBe('');
    expect(normalizeUnit('')).toBe('');
  });
});

describe('addressesMatch()', () => {
  it('matches variants of the same address', () => {
    // El prefijo con límite de palabra se acepta a propósito: los emails traen
    // la misma calle a medias ("175 W 107th") o entera ("175 W 107th St").
    expect(addressesMatch('175 W 107th', '175 W 107th St')).toBe(true);
    expect(addressesMatch('175 W 107th St', '175 W 107th Street')).toBe(true);
    expect(addressesMatch('3221 Carter Ave', '3221 Carter Avenue')).toBe(true);
    expect(addressesMatch('439 W 51st St, NY', '439 West 51st Street, NY 10019')).toBe(true);
  });

  it('does not match different streets', () => {
    expect(addressesMatch('175 W 107th St', '175 W 108th St')).toBe(false);
  });
});

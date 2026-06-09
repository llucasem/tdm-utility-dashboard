import { describe, it, expect } from 'vitest';
import { sanitize } from '../lib/parser.js';

describe('sanitize() — parser post-process', () => {
  it('truncates account_last4 to exactly 4 digits', () => {
    const r = sanitize({ account_last4: '88108', utility_type: 'electricity' });
    expect(r.account_last4).toBe('8108');
  });

  it('handles masked account formats with asterisks', () => {
    const r = sanitize({ account_last4: '*****1234' });
    expect(r.account_last4).toBe('1234');
  });

  it('returns null when account has fewer than 4 digits', () => {
    const r = sanitize({ account_last4: '12' });
    expect(r.account_last4).toBe(null);
  });

  it('extracts Apt N from property_address and moves to unit', () => {
    const r = sanitize({
      property_address: '472 9th Ave, Apt 2, New York, NY 10018',
      unit: null,
    });
    expect(r.property_address).toBe('472 9th Ave, New York, NY 10018');
    expect(r.unit).toBe('Apt 2');
  });

  it('preserves existing unit when extracting Apt from address', () => {
    const r = sanitize({
      property_address: '472 9th Ave, Apt 2, New York, NY 10018',
      unit: '4B',
    });
    expect(r.property_address).toBe('472 9th Ave, New York, NY 10018');
    expect(r.unit).toBe('4B');
  });

  it('normalizes ALL-CAPS address to Title Case', () => {
    const r = sanitize({ property_address: '360 W PICO RD, PALM SPRINGS CA 92262' });
    expect(r.property_address).toContain('Pico');
    expect(r.property_address).toContain('Springs');
    expect(r.property_address).toContain('CA');
  });

  it('returns __skip sentinel for payment confirmations', () => {
    const r = sanitize({
      is_confirmation: true,
      account_last4: '1234',
      amount_due: 100,
    });
    expect(r.__skip).toBe(true);
    expect(r.account_last4).toBe('1234');
  });

  it('coerces invalid amount_due to null', () => {
    const r1 = sanitize({ amount_due: 'not a number', is_confirmation: false });
    expect(r1.amount_due).toBe(null);
    const r2 = sanitize({ amount_due: 0, is_confirmation: false });
    expect(r2.amount_due).toBe(null);
    const r3 = sanitize({ amount_due: 76.25, is_confirmation: false });
    expect(r3.amount_due).toBe(76.25);
  });

  it('falls back utility_type to "other" if invalid', () => {
    const r = sanitize({ utility_type: 'cable', is_confirmation: false });
    expect(r.utility_type).toBe('other');
  });

  it('normalizes unit prefix variations', () => {
    expect(sanitize({ unit: 'apt 4b', is_confirmation: false }).unit).toBe('Apt 4b');
    expect(sanitize({ unit: '#3', is_confirmation: false }).unit).toBe('3');
    expect(sanitize({ unit: 'unit 5', is_confirmation: false }).unit).toBe('Unit 5');
  });

  it('returns null for completely invalid input', () => {
    expect(sanitize(null)).toBe(null);
    expect(sanitize('string')).toBe(null);
    expect(sanitize(42)).toBe(null);
  });
});

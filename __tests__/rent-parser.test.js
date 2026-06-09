import { describe, it, expect } from 'vitest';
import { sanitize } from '../lib/rent-parser.js';

describe('sanitize() — rent classifier post-process', () => {
  it('returns null on non-object input', () => {
    expect(sanitize(null)).toBe(null);
    expect(sanitize('string')).toBe(null);
    expect(sanitize(42)).toBe(null);
  });

  it('defaults to skip when category is invalid', () => {
    const r = sanitize({ category: 'banana', amount_paid: 100 });
    expect(r.category).toBe('skip');
    expect(r.reason).toContain('invalid category');
  });

  it('coerces string amount_paid to number', () => {
    const r = sanitize({ category: 'rent_payment', amount_paid: '$3,500.00', paid_date: '2026-06-01' });
    expect(r.amount_paid).toBe(3500);
  });

  it('demotes rent_payment with no amount to skip', () => {
    const r = sanitize({ category: 'rent_payment', amount_paid: null, confirmation_number: null });
    expect(r.category).toBe('skip');
    expect(r.reason).toContain('demoted');
  });

  it('keeps rent_payment if only confirmation_number is present (still useful)', () => {
    const r = sanitize({
      category: 'rent_payment',
      amount_paid: null,
      confirmation_number: 'CONF-1234',
      paid_date: '2026-06-01',
    });
    expect(r.category).toBe('rent_payment');
    expect(r.amount_paid).toBe(null);
  });

  it('demotes conservice_utility without amount_due', () => {
    const r = sanitize({ category: 'conservice_utility', amount_due: null });
    expect(r.category).toBe('skip');
  });

  it('passes valid rent_payment through unchanged', () => {
    const r = sanitize({
      category: 'rent_payment',
      amount_paid: 3800,
      paid_date: '2026-06-01',
      landlord: 'Greystar',
      payment_portal: 'Bilt',
      confirmation_number: 'a8f2',
      confidence: 'high',
      reason: 'clear confirmation',
    });
    expect(r.category).toBe('rent_payment');
    expect(r.amount_paid).toBe(3800);
    expect(r.landlord).toBe('Greystar');
  });

  it('drops invalid date formats', () => {
    const r = sanitize({ category: 'rent_payment', amount_paid: 100, paid_date: 'June 1, 2026' });
    expect(r.paid_date).toBe(null);
  });

  it('keeps valid YYYY-MM-DD', () => {
    const r = sanitize({ category: 'rent_payment', amount_paid: 100, paid_date: '2026-06-01' });
    expect(r.paid_date).toBe('2026-06-01');
  });

  it('defaults confidence to low if missing', () => {
    const r = sanitize({ category: 'rent_payment', amount_paid: 100 });
    expect(r.confidence).toBe('low');
  });

  it('trims string fields and converts empty to null', () => {
    const r = sanitize({
      category: 'rent_payment',
      amount_paid: 100,
      landlord: '  Greystar  ',
      payment_portal: '',
      property_address: '   ',
    });
    expect(r.landlord).toBe('Greystar');
    expect(r.payment_portal).toBe(null);
    expect(r.property_address).toBe(null);
  });

  it('rejects negative amounts', () => {
    const r = sanitize({ category: 'rent_payment', amount_paid: -100 });
    expect(r.amount_paid).toBe(null);
    expect(r.category).toBe('skip');  // demoted because no amount
  });
});

import { describe, it, expect } from 'vitest';
import { inferVendorFromEmail, vendorMatchesPayee } from '../lib/known-vendors.js';

describe('inferVendorFromEmail()', () => {
  it('detects Spectrum', () => {
    expect(inferVendorFromEmail('Spectrum <MyAccount@spectrumemails.com>')).toEqual(['spectrum']);
  });

  it('detects ConEd in multiple variants', () => {
    const r = inferVendorFromEmail('Con Edison <noreply@billing.coned.com>');
    expect(r).toContain('con edison');
    expect(r).toContain('conedison');
  });

  it('detects SCE', () => {
    const r = inferVendorFromEmail('"sce@message.sce.com" <sce@message.sce.com>');
    expect(r).toContain('sce');
  });

  it('detects SoCalGas', () => {
    expect(inferVendorFromEmail('SoCalGas <customerservice@socalgas.com>')).toEqual(['socalgas']);
  });

  it('detects LADWP', () => {
    const r = inferVendorFromEmail('LADWP <donotreply@ladwp.com>');
    expect(r).toContain('ladwp');
  });

  it('returns null for unrecognized sender', () => {
    expect(inferVendorFromEmail('random@example.com')).toBe(null);
    expect(inferVendorFromEmail('')).toBe(null);
    expect(inferVendorFromEmail(null)).toBe(null);
  });

  it('does not falsely match substring inside another word', () => {
    // "sce" should not match "Costco" or random words
    expect(inferVendorFromEmail('coscoaupplies@example.com')).toBe(null);
  });
});

describe('vendorMatchesPayee()', () => {
  it('matches Spectrum as substring', () => {
    expect(vendorMatchesPayee(['spectrum'], 'Spectrum')).toBe(true);
    expect(vendorMatchesPayee(['spectrum'], 'spectrum cable inc')).toBe(true);
  });

  it('handles ConEd variants', () => {
    expect(vendorMatchesPayee(['con edis', 'conedison'], 'ConEdison')).toBe(true);
    expect(vendorMatchesPayee(['con edis', 'conedison'], 'Con Edison')).toBe(true);
    // "Consolidated Edison" needs a separate entry in the whitelist —
    // the substring "con edis" is NOT contained as-is.
    expect(vendorMatchesPayee(['consolidated edison'], 'Consolidated Edison')).toBe(true);
  });

  it('returns false on no match', () => {
    expect(vendorMatchesPayee(['spectrum'], 'Amazon')).toBe(false);
    expect(vendorMatchesPayee(['spectrum'], '')).toBe(false);
    expect(vendorMatchesPayee(['spectrum'], null)).toBe(false);
  });

  it('returns false on empty expected list', () => {
    expect(vendorMatchesPayee([], 'Spectrum')).toBe(false);
    expect(vendorMatchesPayee(null, 'Spectrum')).toBe(false);
  });

  it('regression: Yaritza is NOT a Spectrum vendor', () => {
    expect(vendorMatchesPayee(['spectrum'], 'Yaritza Gomez')).toBe(false);
  });
});

import { describe, it, expect } from 'vitest';
import { mapBillRow } from '../lib/bill-view.js';

// Los DOS ejes de mes que pidio Jake: dueMonth (factura) y paidMonth (pago).
// El caso medido que motiva el selector: 144 de 468 facturas (31%) se pagan
// en un mes distinto del que llegan.

const fila = (extra = {}) => ({
  id: 1, utility_type: 'electricity',
  property_address: '2200 Colorado Ave, Santa Monica, CA 90404', unit: '630',
  account_last4: '3364', amount_due: '136.21',
  email_received_at: '2026-06-24T18:00:00Z', due_date: null,
  status: 'pending', gmail_message_id: 'abc123', ...extra,
});

describe('mapBillRow — eje de factura (Devengo)', () => {
  it('agrupa por el mes en que llego el email', () => {
    const b = mapBillRow(fila());
    expect(b.dueMonth).toBe(5);      // junio (0-index)
    expect(b.dueYear).toBe(2026);
  });
});

describe('mapBillRow — pago derivado de payments/bill_payments', () => {
  it('prefiere las tablas nuevas sobre el JSON del match', () => {
    const b = mapBillRow(fila({
      qb_match_status: 'matched',
      qb_match_data: [{ id: '21927', date: '2026-07-01', amount: 100 }],  // JSON viejo
      pay_date: new Date(2026, 6, 6),   // 6 de julio, medianoche LOCAL (asi lo entrega pg)
      pay_amount: '136.21',
      pay_items: [{ qbId: '21927', date: '2026-07-06', amount: 136.21 }],
    }));
    expect(b.paidDate).toBe('2026-07-06');   // NO 2026-07-05: sin resbalon de huso
    expect(b.paidAmount).toBe(136.21);
    expect(b.payments).toHaveLength(1);
  });

  it('sin fila en payments cae al JSON del match (reserva)', () => {
    const b = mapBillRow(fila({
      qb_match_status: 'matched',
      qb_match_data: [{ id: 'x', date: '2026-07-06', amount: 42 }],
    }));
    expect(b.paidDate).toBe('2026-07-06');
    expect(b.paidAmount).toBe(42);
    expect(b.payments).toEqual([]);
  });
});

describe('mapBillRow — eje de pago (Caja)', () => {
  it('saca la fecha de pago del match de QuickBooks', () => {
    // El caso literal de la revision de julio de Jake: factura de junio
    // pagada el 6 de julio. En Devengo es de junio; en Caja, de julio.
    const b = mapBillRow(fila({
      qb_match_status: 'matched',
      qb_match_data: [{ id: '21927', date: '2026-07-06', amount: 136.21 }],
    }));
    expect(b.paidDate).toBe('2026-07-06');
    expect(b.paidMonth).toBe(6);     // julio
    expect(b.paidYear).toBe(2026);
    expect(b.dueMonth).toBe(5);      // y sigue siendo factura de junio
  });

  it('sin pago casado no hay mes de pago — la factura queda FUERA de todo mes en Caja', () => {
    // Aqui vive la deuda de Maxella: not_found no puede convertirse en un
    // mes inventado. La UI la ensena en la franja de "sin pagar".
    const b = mapBillRow(fila({ qb_match_status: 'not_found', qb_match_data: [] }));
    expect(b.paidDate).toBeNull();
    expect(b.paidMonth).toBeNull();
    expect(b.paidYear).toBeNull();
  });

  it('un match sin fecha tampoco inventa mes', () => {
    const b = mapBillRow(fila({ qb_match_status: 'matched', qb_match_data: [{ id: 'x', amount: 5 }] }));
    expect(b.paidMonth).toBeNull();
  });

  it('las filas que vienen de QuickBooks traen su propio pago', () => {
    const b = mapBillRow(fila({
      source: 'qb', gmail_message_id: 'qb:25284',
      qb_match_status: 'matched',
      qb_match_data: [{ id: '25284', date: '2026-07-20', amount: 10817.34 }],
    }));
    expect(b.paidMonth).toBe(6);
    expect(b.gmailLink).toBeNull();  // no hay email que enlazar
  });
});

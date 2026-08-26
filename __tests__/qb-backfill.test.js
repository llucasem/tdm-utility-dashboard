import { describe, it, expect } from 'vitest';
import { claveCobertura, yaLlegaPorEmail, alinearUnidad } from '../lib/qb-backfill.js';

/**
 * qb-backfill existe para UNA cosa: crear filas de cuentas que NO mandan
 * email. Cuando se pasa de ahi, cuenta el mismo recibo dos veces — y eso es
 * lo que Jake veia como importes inflados en su revision de julio.
 */

describe('claveCobertura', () => {
  it('agrupa la misma propiedad aunque venga escrita de otra forma', () => {
    expect(claveCobertura('electricity', '607 2nd Ave, New York, NY 10016', 'Apt 3'))
      .toBe(claveCobertura('electricity', '607 2ND AVE', '3'));
  });

  it('distingue unidades y tipos de servicio', () => {
    expect(claveCobertura('electricity', '607 2nd Ave', '2'))
      .not.toBe(claveCobertura('electricity', '607 2nd Ave', '3'));
    expect(claveCobertura('electricity', '607 2nd Ave', '3'))
      .not.toBe(claveCobertura('internet', '607 2nd Ave', '3'));
  });
});

describe('yaLlegaPorEmail', () => {
  // 607 2nd Ave #3 recibe 16 facturas de ConEd por email, y el backfill le
  // creaba otra encima desde QuickBooks. Ese era el duplicado.
  const cobertura = new Set([
    claveCobertura('electricity', '607 2nd Ave, New York, NY 10016', '3'),
    claveCobertura('internet',    '507 Wilshire Blvd, Santa Monica, CA 90401', '313'),
  ]);

  it('detecta que esa propiedad ya recibe facturas por email', () => {
    expect(yaLlegaPorEmail(cobertura, 'electricity', '607 2ND AVE', 'Apt 3')).toBe(true);
    expect(yaLlegaPorEmail(cobertura, 'internet', '507 WILSHIRE BLVD', '313')).toBe(true);
  });

  it('deja pasar las cuentas que NO mandan email — su razon de existir', () => {
    // AT&T en 7141 Santa Monica #321 no manda ningun email: esta fila SI
    // tiene que crearse desde QuickBooks.
    expect(yaLlegaPorEmail(cobertura, 'internet', '7141 Santa Monica Blvd', '321')).toBe(false);
    // Y otra unidad del mismo edificio tampoco esta cubierta.
    expect(yaLlegaPorEmail(cobertura, 'electricity', '607 2nd Ave', '2')).toBe(false);
    // Ni otro servicio en la misma unidad.
    expect(yaLlegaPorEmail(cobertura, 'gas', '607 2nd Ave', '3')).toBe(false);
  });

  it('el importe NO entra en la decision', () => {
    // El fallo anterior: preguntaba "¿hay una factura de este importe exacto?".
    // Como la factura trae el saldo y el pago es otra cifra, contestaba que no
    // y creaba el duplicado. Ahora la pregunta es por propiedad, no por dinero.
    expect(yaLlegaPorEmail(cobertura, 'electricity', '607 2nd Ave', '3')).toBe(true);
  });
});

describe('alinearUnidad', () => {
  it('respeta la unidad cuando el registro ya la conoce', () => {
    expect(alinearUnidad('313', ['313', '410'])).toBe('313');
  });

  it('alinea la notacion de QuickBooks con la del registro', () => {
    expect(alinearUnidad('M03', ['M3', '607', '806'])).toBe('M3');
    expect(alinearUnidad('1-461', ['461', '183', '382'])).toBe('461');
    expect(alinearUnidad('01-461', ['461'])).toBe('461');
  });

  it('quita el prefijo "Apt" como cualquier otra unidad', () => {
    expect(alinearUnidad('Apt 469', ['469'])).toBe('469');
  });

  it('si hay dos candidatas igual de validas, no elige — deja la original', () => {
    // Preferimos una unidad rara y visible a una inventada con seguridad.
    expect(alinearUnidad('M03', ['M3', 'M003'])).toBe('M03');
  });

  it('si no hay ninguna equivalente, deja la de QuickBooks', () => {
    expect(alinearUnidad('999', ['461', '382'])).toBe('999');
  });

  it('sin unidad devuelve null', () => {
    expect(alinearUnidad(null, ['461'])).toBeNull();
    expect(alinearUnidad('-', ['461'])).toBeNull();
  });
});

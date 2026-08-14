import { describe, it, expect } from 'vitest';
import {
  normAddress, normUnit, accountKey, resolveAccount, loadRegistry, CONFIABLES,
} from '../lib/account-registry.js';

describe('normAddress', () => {
  it('se queda con la calle y unifica abreviaturas', () => {
    expect(normAddress('3221 Carter Avenue, Marina Del Rey, CA 90292')).toBe('3221 CARTER AVE');
    expect(normAddress('1420 5th Street, Santa Monica, CA 90401')).toBe('1420 5TH ST');
    expect(normAddress('620 Santa Monica Boulevard')).toBe('620 SANTA MONICA BLVD');
    expect(normAddress('360 W Pico Road')).toBe('360 W PICO RD');
  });

  it('NO se come los tokens direccionales', () => {
    // El normalizador anterior convertia "507 WILSHIRE BLVD" en
    // "507 WIL HIRE BLVD" al tratar la S como direccional. Datos corrompidos
    // en la base durante meses.
    expect(normAddress('507 Wilshire Blvd')).toBe('507 WILSHIRE BLVD');
    expect(normAddress('939 S Broadway')).toBe('939 S BROADWAY');
    expect(normAddress('439 W 51st St')).toBe('439 W 51ST ST');
    expect(normAddress('501 E 106th St')).toBe('501 E 106TH ST');
  });

  it('trata igual las variantes con y sin comas', () => {
    expect(normAddress('4250 Glencoe Ave, Marina del Rey, CA 90292'))
      .toBe(normAddress('4250 Glencoe Ave'));
  });

  it('aguanta entradas vacias', () => {
    expect(normAddress(null)).toBeNull();
    expect(normAddress('')).toBeNull();
    expect(normAddress('   ')).toBeNull();
  });
});

describe('normUnit', () => {
  it('quita los prefijos y deja la unidad desnuda', () => {
    expect(normUnit('Apt 607')).toBe('607');
    expect(normUnit('#607')).toBe('607');
    expect(normUnit(' 607 ')).toBe('607');
    expect(normUnit('Unit 447')).toBe('447');
    expect(normUnit('Suite 12')).toBe('12');
  });

  it('todas las formas de escribir la misma unidad colapsan en una', () => {
    const formas = ['607', '#607', 'Apt 607', 'APT 607', ' 607', 'apt. 607'];
    const unicas = new Set(formas.map(normUnit));
    expect([...unicas]).toEqual(['607']);
  });

  it('conserva los designadores de NYC', () => {
    expect(normUnit('3FL')).toBe('3FL');
    expect(normUnit('4D')).toBe('4D');
    expect(normUnit('2W')).toBe('2W');
    expect(normUnit('Apt 4FL')).toBe('4FL');
  });

  it('devuelve null cuando no hay unidad', () => {
    expect(normUnit(null)).toBeNull();
    expect(normUnit('')).toBeNull();
    expect(normUnit('-')).toBeNull();
    expect(normUnit('null')).toBeNull();
  });
});

describe('resolveAccount', () => {
  const registry = new Map([
    ['internet|8625', { property_address: '4750 LINCOLN BLVD', unit: '382' }],
    ['gas|4904',      { property_address: '1528 6TH ST',       unit: '209' }],
  ]);

  it('encuentra la cuenta registrada', () => {
    expect(resolveAccount(registry, 'internet', '8625').property_address).toBe('4750 LINCOLN BLVD');
  });

  it('el tipo de servicio forma parte de la clave', () => {
    // Dos proveedores distintos pueden acabar en los mismos 4 digitos.
    expect(resolveAccount(registry, 'gas', '8625')).toBeNull();
  });

  it('devuelve null si no hay cuenta, en vez de adivinar', () => {
    expect(resolveAccount(registry, 'internet', '0000')).toBeNull();
    expect(resolveAccount(registry, 'internet', null)).toBeNull();
  });
});

describe('accountKey', () => {
  it('es estable y distingue tipo de servicio', () => {
    expect(accountKey('gas', '4904')).toBe('gas|4904');
    expect(accountKey('gas', '4904')).not.toBe(accountKey('electricity', '4904'));
  });
});

describe('loadRegistry', () => {
  it('por defecto solo carga las cuentas de fiar', async () => {
    let capturado = null;
    const db = { async query(sql, params) { capturado = { sql, params }; return { rows: [] }; } };
    await loadRegistry(db);
    expect(capturado.sql).toContain('confidence = any($1)');
    expect(capturado.params[0]).toEqual(CONFIABLES);
    expect(CONFIABLES).toEqual(['solida', 'mayoria', 'manual']);
  });

  it('devuelve un Map indexado por tipo+cuenta', async () => {
    const db = { async query() { return { rows: [
      { utility_type: 'gas', account_last4: '4904', property_address: '1528 6TH ST', unit: '209' },
    ]}; }};
    const reg = await loadRegistry(db);
    expect(reg.get('gas|4904').property_address).toBe('1528 6TH ST');
  });

  it('las cuentas provisionales o en conflicto no entran solas', async () => {
    // Una cuenta que no es de fiar debe dejar la factura sin asignar para que
    // la resuelva una persona, no asignarla a medias.
    expect(CONFIABLES).not.toContain('provisional');
    expect(CONFIABLES).not.toContain('conflicto');
    expect(CONFIABLES).not.toContain('sin_datos');
  });
});

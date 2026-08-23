import { describe, it, expect } from 'vitest';
import {
  normAddress, normUnit, accountKey, resolveAccount, loadRegistry, CONFIABLES,
  pickDisplayAddress,
} from '../lib/account-registry.js';

// Estas 62 grafias son las que habia de verdad en la base para 30 propiedades.
// Jake reporto en su revision de julio que el dashboard le mostraba la misma
// propiedad partida en varios grupos, y por eso los totales no cuadraban.
describe('una propiedad, una sola clave', () => {
  const mismaCalle = [
    ['1420 5TH ST', ['1420 5th St, Santa Monica, CA 90401', '1420 5TH ST']],
    ['439 W 51ST ST', ['439 West 51st Street, New York, NY 10019', '439 W 51st St, New York, NY 10019', '439 WEST 51ST ST']],
    ['7141 SANTA MONICA BLVD', ['7141 Santa Monica Blvd W Hollywood CA 90046', '7141 Santa Monica Blvd, West Hollywood, CA 90046']],
    ['4241 REDWOOD AVE', ['4241 Redwood Avenue Los Angeles CA, 90066', '4241 Redwood Ave, Los Angeles, CA 90066']],
    ['4250 GLENCOE AVE', ['4250 Glencoe Ave Marina del Rey CA 90292']],
    ['6677 SANTA MONICA BLVD', ['6677 Santa Monica Blvd, Los Angeles CA 90038', '6677 Santa Monica Blvd, Los Angeles, CA 90038', '6677 SANTA MONICA BLVD']],
  ];

  for (const [canonica, grafias] of mismaCalle) {
    it(`todas las formas de "${canonica}" dan la misma clave`, () => {
      for (const g of grafias) expect(normAddress(g)).toBe(canonica);
    });
  }

  it('no confunde el "ST" de Street con un estado de dos letras', () => {
    // "620 SANTA MONICA BLVD" tampoco puede perder su nombre por contener
    // el nombre de una ciudad.
    expect(normAddress('1548 6th St')).toBe('1548 6TH ST');
    expect(normAddress('620 Santa Monica Blvd, Santa Monica, CA 90401')).toBe('620 SANTA MONICA BLVD');
  });
});

describe('pickDisplayAddress', () => {
  it('prefiere la direccion completa y bien puntuada', () => {
    expect(pickDisplayAddress([
      { text: '2200 COLORADO AVE', count: 12 },
      { text: '2200 Colorado Ave, Santa Monica, CA 90404', count: 58 },
    ])).toBe('2200 Colorado Ave, Santa Monica, CA 90404');
  });

  it('dos comas ganan a una, aunque la mal puntuada se repita mas', () => {
    expect(pickDisplayAddress([
      { text: '4241 Redwood Avenue Los Angeles CA, 90066', count: 7 },
      { text: '4241 Redwood Ave, Los Angeles, CA 90066', count: 1 },
    ])).toBe('4241 Redwood Ave, Los Angeles, CA 90066');
  });

  it('conserva el tipo de via: "175 W 107th St" gana a "175 W 107th"', () => {
    expect(pickDisplayAddress([
      { text: '175 W 107th, New York, NY 10025', count: 17 },
      { text: '175 W 107th St, New York, NY 10025', count: 8 },
    ])).toBe('175 W 107th St, New York, NY 10025');
  });

  it('si solo hay mayusculas, al menos elige la de mejor lectura', () => {
    expect(pickDisplayAddress([
      { text: '2614 VOORHEES AVE', count: 4 },
      { text: '2614 Voorhees Ave', count: 4 },
    ])).toBe('2614 Voorhees Ave');
  });
});

describe('normAddress', () => {
  it('se queda con la calle y unifica abreviaturas', () => {
    expect(normAddress('3221 Carter Avenue, Marina Del Rey, CA 90292')).toBe('3221 CARTER AVE');
    expect(normAddress('1420 5th Street, Santa Monica, CA 90401')).toBe('1420 5TH ST');
    expect(normAddress('620 Santa Monica Boulevard')).toBe('620 SANTA MONICA BLVD');
    expect(normAddress('360 W Pico Road')).toBe('360 W PICO RD');
  });

  it('NO se come los tokens direccionales', () => {
    // Ninguna abreviatura ni token direccional puede alterar el nombre de la
    // calle. Las direcciones son la clave con la que se agrupan las facturas:
    // una letra de menos y la propiedad deja de cuadrar.
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

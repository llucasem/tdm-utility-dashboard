import { describe, it, expect, beforeEach } from 'vitest';
import {
  idFactura, resolverPropiedad, esDuplicada, marcarPagada,
  procesarEmail, VENTANA_DUP_DIAS,
} from '../lib/sync-core.js';

/**
 * Doble de base de datos: apunta cada consulta y responde lo que le digamos.
 * Permite comprobar la logica de decision entera sin Neon.
 */
function fakeDb(opts = {}) {
  const { duplicada = false, facturaPagadaId = null, idInsertado = 101, yaExistia = false } = opts;
  const calls = [];
  return {
    calls,
    hechas: (fragmento) => calls.filter(c => c.sql.includes(fragmento)),
    async query(sql, params) {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });

      if (/SELECT 1 FROM utility_bills/i.test(sql))
        return duplicada ? { rowCount: 1, rows: [{ '?column?': 1 }] } : { rowCount: 0, rows: [] };

      if (/UPDATE utility_bills SET status/i.test(sql))
        return facturaPagadaId
          ? { rowCount: 1, rows: [{ id: facturaPagadaId }] }
          : { rowCount: 0, rows: [] };

      if (/INSERT INTO utility_bills/i.test(sql))
        return yaExistia ? { rowCount: 0, rows: [] } : { rowCount: 1, rows: [{ id: idInsertado }] };

      return { rowCount: 0, rows: [] };
    },
  };
}

const email = (over = {}) => ({
  id: 'msg-1', from: 'Spectrum <myaccount@spectrumemails.com>',
  subject: 'Your Spectrum Statement is Ready', date: '2026-08-14T10:00:00Z',
  body: '', snippet: '', ...over,
});

const factura = (over = {}) => ({
  kind: 'bill', utility_type: 'internet', account_last4: '8625',
  amount_due: 79.99, due_date: '2026-08-25', template: 'spectrum/statement', ...over,
});

let registry;
beforeEach(() => {
  registry = new Map([
    ['internet|8625', { property_address: '4750 LINCOLN BLVD', display_address: '4750 Lincoln Blvd, Marina Del Rey, CA 90292', unit: '382', confidence: 'solida' }],
    ['gas|4904',      { property_address: '1528 6TH ST',       display_address: '1528 6th St, Santa Monica, CA 90401',        unit: '209', confidence: 'manual' }],
  ]);
});

// ─────────────────────────────────────────────────────────────────────────────

describe('idFactura', () => {
  it('un email con una sola factura usa el id de Gmail tal cual', () => {
    expect(idFactura('abc', factura(), 1)).toBe('abc');
  });

  it('un consolidado da un id distinto a cada factura', () => {
    const a = idFactura('abc', factura({ account_last4: '1111', amount_due: 10 }), 3);
    const b = idFactura('abc', factura({ account_last4: '2222', amount_due: 20 }), 3);
    expect(a).not.toBe(b);
    expect(a.startsWith('abc#')).toBe(true);
  });

  it('dos facturas de la misma cuenta con distinto importe no colisionan', () => {
    const a = idFactura('abc', factura({ account_last4: '1111', amount_due: 10 }), 2);
    const b = idFactura('abc', factura({ account_last4: '1111', amount_due: 25.5 }), 2);
    expect(a).not.toBe(b);
  });
});

describe('resolverPropiedad', () => {
  it('el registro manda, y la factura lleva la direccion de MOSTRAR', () => {
    const p = resolverPropiedad(registry, factura());
    expect(p).toMatchObject({
      address: '4750 Lincoln Blvd, Marina Del Rey, CA 90292',   // lo que ve Jake
      canonical: '4750 LINCOLN BLVD',                           // la clave que agrupa
      unit: '382', origen: 'registro',
    });
  });

  it('si la cuenta no esta registrada, usa la direccion del propio email', () => {
    const p = resolverPropiedad(registry, factura({
      account_last4: '9999', service_address: '939 S Broadway', unit: 'Apt 508',
    }));
    expect(p).toMatchObject({ address: '939 S Broadway', canonical: '939 S BROADWAY', unit: '508', origen: 'email' });
  });

  it('sin registro y sin direccion, queda sin asignar para que Jake la resuelva una vez', () => {
    const p = resolverPropiedad(registry, factura({ account_last4: '9999' }));
    expect(p).toMatchObject({ address: null, unit: null, origen: 'sin asignar' });
  });

  it('el registro gana al email, pero deja constancia de la discrepancia', () => {
    // Esto es deliberado: si el proveedor cambia de direccion queremos
    // enterarnos, no que el dato cambie solo. Ese cambio silencioso es
    // exactamente lo que hacia el sistema anterior.
    const p = resolverPropiedad(registry, factura({ service_address: '1 OTRA CALLE' }));
    expect(p.canonical).toBe('4750 LINCOLN BLVD');
    expect(p.discrepancia).toContain('1 OTRA CALLE');
  });

  it('no marca discrepancia cuando el email dice lo mismo que el registro', () => {
    const p = resolverPropiedad(registry, factura({ service_address: '4750 Lincoln Blvd Apt 382' }));
    expect(p.discrepancia).toBeNull();
  });
});

describe('esDuplicada', () => {
  it('usa la ventana de 18 dias y los datos de la factura', async () => {
    const db = fakeDb({ duplicada: true });
    expect(await esDuplicada(db, factura(), '2026-08-14T10:00:00Z')).toBe(true);
    const [c] = db.hechas('SELECT 1 FROM utility_bills');
    expect(c.params).toEqual(['internet', '8625', 79.99, '2026-08-14T10:00:00Z', VENTANA_DUP_DIAS]);
  });

  it('sin cuenta o sin importe no puede decidir, asi que no marca duplicado', async () => {
    const db = fakeDb({ duplicada: true });
    expect(await esDuplicada(db, factura({ account_last4: null }), '2026-08-14')).toBe(false);
    expect(await esDuplicada(db, factura({ amount_due: null }), '2026-08-14')).toBe(false);
    expect(db.hechas('SELECT 1 FROM utility_bills')).toHaveLength(0);
  });
});

describe('marcarPagada', () => {
  it('devuelve el id de la factura que ha marcado', async () => {
    const db = fakeDb({ facturaPagadaId: 77 });
    expect(await marcarPagada(db, factura(), '2026-08-14')).toBe(77);
  });

  it('devuelve null si no hay ninguna factura que case', async () => {
    const db = fakeDb({ facturaPagadaId: null });
    expect(await marcarPagada(db, factura(), '2026-08-14')).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe('procesarEmail', () => {
  it('el ruido se registra pero NO crea factura', async () => {
    const db = fakeDb();
    const r = await procesarEmail({ db, email: email(), registry,
      lectura: { kind: 'noise', template: 'spectrum/otro' } });

    expect(r.billIds).toHaveLength(0);
    expect(db.hechas('INSERT INTO utility_bills')).toHaveLength(0);
    expect(db.hechas('INSERT INTO processed_emails')).toHaveLength(1);
    expect(r.acciones[0].decision).toBe('noise');
  });

  it('una factura se guarda con la propiedad del registro', async () => {
    const db = fakeDb({ idInsertado: 55 });
    const r = await procesarEmail({ db, email: email(), registry, lectura: factura() });

    expect(r.billIds).toEqual([55]);
    const [ins] = db.hechas('INSERT INTO utility_bills');
    expect(ins.params[0]).toBe('msg-1');              // id de Gmail
    expect(ins.params[2]).toBe('4750 Lincoln Blvd, Marina Del Rey, CA 90292');  // forma de mostrar
    expect(ins.params[3]).toBe('382');                // unidad del registro
    expect(ins.params[10]).toBe(false);               // no es duplicada
  });

  it('un recordatorio del mismo recibo se guarda marcado como duplicado', async () => {
    const db = fakeDb({ duplicada: true });
    const r = await procesarEmail({ db, email: email(), registry, lectura: factura() });
    expect(db.hechas('INSERT INTO utility_bills')[0].params[10]).toBe(true);
    expect(r.acciones[0].duplicada).toBe(true);
  });

  it('una confirmacion de pago marca pagada la factura y NO crea otra', async () => {
    const db = fakeDb({ facturaPagadaId: 42 });
    const r = await procesarEmail({ db, email: email(), registry,
      lectura: { kind: 'payment', utility_type: 'electricity', account_last4: '7417',
                 amount_due: 117.87, template: 'coned/pago-recibido' } });

    expect(db.hechas('INSERT INTO utility_bills')).toHaveLength(0);
    expect(db.hechas('UPDATE utility_bills SET status')).toHaveLength(1);
    expect(r.acciones[0]).toMatchObject({ decision: 'payment', facturaId: 42 });
  });

  it('un pago sin factura que casar queda anotado para poder investigarlo', async () => {
    const db = fakeDb({ facturaPagadaId: null });
    await procesarEmail({ db, email: email(), registry,
      lectura: { kind: 'payment', utility_type: 'gas', account_last4: '0000',
                 amount_due: 9.99, template: 'x' } });
    const [reg] = db.hechas('INSERT INTO processed_emails');
    expect(reg.params[10]).toBe('sin factura que casar');
  });

  it('un saldo a favor se registra sin crear factura', async () => {
    const db = fakeDb();
    await procesarEmail({ db, email: email(), registry,
      lectura: { kind: 'credit', utility_type: 'gas', account_last4: '9031',
                 amount_due: 0, credit_balance: 0.05, template: 'socalgas/saldo-a-favor' } });

    expect(db.hechas('INSERT INTO utility_bills')).toHaveLength(0);
    expect(db.hechas('INSERT INTO processed_emails')[0].params[2]).toBe('credit');
  });

  it('un consolidado crea una factura por linea, con ids distintos', async () => {
    const db = fakeDb();
    const r = await procesarEmail({ db, email: email(), registry, lectura: {
      kind: 'multi', provider: 'ConEd', items: [
        factura({ utility_type: 'electricity', account_last4: '1111', amount_due: 10 }),
        factura({ utility_type: 'electricity', account_last4: '2222', amount_due: 20 }),
      ],
    }});

    const ins = db.hechas('INSERT INTO utility_bills');
    expect(ins).toHaveLength(2);
    expect(ins[0].params[0]).not.toBe(ins[1].params[0]);
    expect(r.billIds).toHaveLength(2);
  });

  it('una cuenta nueva con direccion en el email se registra sola', async () => {
    const db = fakeDb();
    await procesarEmail({ db, email: email(), registry, lectura: factura({
      account_last4: '7777', service_address: '620 Santa Monica Blvd', unit: 'Apt 510',
    })});

    const [reg] = db.hechas('INSERT INTO account_registry');
    expect(reg.params[1]).toBe('7777');
    expect(reg.params[3]).toBe('620 SANTA MONICA BLVD');          // canonica
    expect(reg.params[4]).toBe('620 Santa Monica Blvd');          // de mostrar
    expect(reg.params[5]).toBe('510');
    expect(reg.sql).toContain("'provisional'");   // nace sin confirmar
    // y queda disponible en memoria para el resto de la pasada
    expect(registry.get('internet|7777').property_address).toBe('620 SANTA MONICA BLVD');
  });

  it('una factura sin propiedad se anota para que Jake la resuelva una vez', async () => {
    const db = fakeDb();
    const r = await procesarEmail({ db, email: email(), registry,
      lectura: factura({ account_last4: '9999' }) });

    expect(r.revisar).toEqual([{ utility_type: 'internet', account_last4: '9999', amount: 79.99 }]);
    expect(db.hechas('INSERT INTO account_registry')).toHaveLength(0);
  });

  it('si el email ya estaba guardado no se duplica ni se cuenta como nuevo', async () => {
    const db = fakeDb({ yaExistia: true });
    const r = await procesarEmail({ db, email: email(), registry, lectura: factura() });
    expect(r.billIds).toHaveLength(0);
    expect(r.acciones[0].decision).toBe('ya-existia');
  });

  it('un remitente desconocido sin IA disponible se aplaza, no se pierde', async () => {
    const db = fakeDb();
    const r = await procesarEmail({ db, email: email({ from: 'agua@ejemplo.com' }),
      registry, lectura: null, iaFallback: null });

    expect(r.acciones[0].decision).toBe('deferred');
    // No se registra: asi Gmail lo vuelve a ofrecer en la siguiente pasada.
    expect(db.hechas('INSERT INTO processed_emails')).toHaveLength(0);
  });

  it('si la IA falla, el email queda anotado como error y la pasada continua', async () => {
    const db = fakeDb();
    const r = await procesarEmail({ db, email: email({ from: 'agua@ejemplo.com' }),
      registry, lectura: null, iaFallback: async () => { throw new Error('credit balance too low'); } });

    expect(r.acciones[0].decision).toBe('error');
    expect(db.hechas('INSERT INTO processed_emails')[0].params[2]).toBe('error');
  });

  it('la IA de reserva puede producir una factura normal', async () => {
    const db = fakeDb({ idInsertado: 9 });
    const r = await procesarEmail({ db, email: email({ from: 'agua@ejemplo.com' }),
      registry, lectura: null,
      iaFallback: async () => factura({ utility_type: 'water', account_last4: '3131', amount_due: 42, template: 'ia/reserva' }) });

    expect(r.billIds).toEqual([9]);
    expect(db.hechas('INSERT INTO utility_bills')[0].params[1]).toBe('water');
  });
});

describe('lectura real de punta a punta', () => {
  it('un email de SoCalGas entra por las reglas y sale como factura con su propiedad', async () => {
    const db = fakeDb({ idInsertado: 300 });
    // Sin `lectura`: se calcula con las reglas de proveedor de verdad.
    const r = await procesarEmail({ db, registry, email: email({
      from: 'SoCalGas <customerservice@socalgas.com>',
      subject: 'Your Automatic Monthly Payment is scheduled',
      body: `Payment Amount $1.28 Account Number *****44904 (VERONA 209) Scheduled Payment Date 08/12/2026`,
    })});

    const [ins] = db.hechas('INSERT INTO utility_bills');
    expect(ins.params[1]).toBe('gas');
    expect(ins.params[2]).toBe('1528 6th St, Santa Monica, CA 90401');   // del registro, no del email
    expect(ins.params[3]).toBe('209');
    expect(ins.params[4]).toBe('4904');
    expect(ins.params[5]).toBe(1.28);
    expect(r.billIds).toEqual([300]);
  });

  it('el marketing de Spectrum no llega nunca a la tabla de facturas', async () => {
    const db = fakeDb();
    await procesarEmail({ db, registry, email: email({
      subject: 'See the savings add up with free Spectrum Mobile service',
      body: 'Get a free line for 12 months. Save $240.00 this year!',
    })});
    expect(db.hechas('INSERT INTO utility_bills')).toHaveLength(0);
  });
});

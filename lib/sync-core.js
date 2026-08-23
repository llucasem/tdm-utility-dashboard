/**
 * El cerebro del sync, separado de la ruta HTTP para poder probarlo.
 *
 * Todo lo que toca la base de datos recibe `db` (cualquier cosa con .query).
 * En produccion es el Pool de Neon; en los tests es un doble que devuelve
 * filas preparadas. Asi se puede comprobar la logica de decision entera sin
 * Gmail, sin Claude y sin base de datos.
 */
import { extractBill } from './providers.js';
import { resolveAccount, normAddress, normUnit } from './account-registry.js';

export const VENTANA_DUP_DIAS = 18;   // recordatorios del mismo recibo
export const VENTANA_PAGO_DIAS = 45;  // cuanto atras busca un pago su factura

/**
 * Un email consolidado genera varias facturas y cada una necesita su propio
 * identificador, porque la clave unica es el id del mensaje de Gmail.
 */
export function idFactura(emailId, item, total) {
  if (total <= 1) return emailId;
  return `${emailId}#${item.account_last4}-${item.amount_due}`;
}

/**
 * De donde sale la propiedad de una factura, por orden de autoridad:
 *   1. El registro de cuentas. Es la fuente de verdad.
 *   2. La direccion que venga en el propio email (Spectrum y el consolidado
 *      de ConEd la incluyen). Solo si la cuenta no esta registrada todavia.
 *   3. Nada: la factura queda sin asignar y Jake la resuelve UNA vez.
 *
 * El registro manda sobre el email a proposito. Si el proveedor empieza a
 * mandar otra direccion para la misma cuenta, queremos enterarnos y revisarlo,
 * no que el dato cambie solo — que es justo lo que hacia el sistema anterior.
 */
/**
 * Quita del final un designador de unidad ("... APT 382") para poder comparar
 * dos direcciones sin que la unidad las haga parecer distintas.
 */
function soloCalle(dir) {
  if (!dir) return null;
  return String(dir).replace(/\s+(?:APT|UNIT|STE|SUITE|FL|#)\s*[\w-]+\s*$/i, '').trim() || null;
}

export function resolverPropiedad(registry, item) {
  const reg = resolveAccount(registry, item.utility_type, item.account_last4);
  if (reg) {
    const delEmail = item.service_address ? normAddress(item.service_address) : null;
    const discrepa = delEmail && soloCalle(delEmail) !== soloCalle(reg.property_address);
    return {
      // En la factura va SIEMPRE la forma de mostrar. La canonica es solo la
      // clave para agrupar: si acaba en utility_bills, la misma propiedad
      // aparece dos veces en el dashboard y los totales no cuadran — que es
      // justo lo que reporto Jake en su revision de julio.
      address: reg.display_address || reg.property_address,
      canonical: reg.property_address,
      unit: reg.unit,
      origen: 'registro',
      discrepancia: discrepa ? `el email dice "${delEmail}"` : null,
    };
  }

  if (item.service_address) {
    return {
      address: item.service_address,             // tal cual lo manda el proveedor
      canonical: normAddress(item.service_address),
      unit: normUnit(item.unit),
      origen: 'email',
      discrepancia: null,
    };
  }

  return { address: null, canonical: null, unit: null, origen: 'sin asignar', discrepancia: null };
}

/**
 * Los proveedores mandan varios avisos del mismo recibo: ConEd "Bill Is Ready"
 * y luego "Bill Is Due" 12-14 dias despues; Spectrum el statement y luego la
 * domiciliacion ~8 dias despues. Misma cuenta + mismo importe dentro de 18
 * dias = el mismo recibo. Los ciclos mensuales de verdad van a 28-31 dias, asi
 * que la ventana no puede tapar una factura real.
 */
export async function esDuplicada(db, item, fecha) {
  if (!item.account_last4 || !item.amount_due) return false;
  const r = await db.query(
    `SELECT 1 FROM utility_bills
      WHERE utility_type = $1 AND account_last4 = $2
        AND ROUND(amount_due::numeric,2) = ROUND($3::numeric,2)
        AND NOT coalesce(is_duplicate,false)
        AND email_received_at BETWEEN $4::timestamptz - make_interval(days => $5)
                                  AND $4::timestamptz + make_interval(days => $5)
      LIMIT 1`,
    [item.utility_type, item.account_last4, item.amount_due, fecha, VENTANA_DUP_DIAS]
  );
  return r.rowCount > 0;
}

/**
 * Una confirmacion de pago no crea factura: marca pagada la que le
 * corresponde. Si no encuentra ninguna devuelve null, y queda constancia en
 * processed_emails para poder investigarlo.
 */
export async function marcarPagada(db, item, fecha) {
  if (!item.account_last4 || !item.amount_due) return null;
  const r = await db.query(
    `UPDATE utility_bills SET status = 'paid'
      WHERE id = (
        SELECT id FROM utility_bills
         WHERE utility_type = $1 AND account_last4 = $2
           AND ROUND(amount_due::numeric,2) = ROUND($3::numeric,2)
           AND status <> 'paid' AND NOT coalesce(is_duplicate,false)
           AND email_received_at BETWEEN $4::timestamptz - make_interval(days => $5)
                                     AND $4::timestamptz + interval '5 days'
         ORDER BY email_received_at DESC LIMIT 1)
      RETURNING id`,
    [item.utility_type, item.account_last4, item.amount_due, fecha, VENTANA_PAGO_DIAS]
  );
  return r.rows[0]?.id ?? null;
}

/** Deja constancia de que este email ya se miro, decida lo que decida. */
export async function registrarEmail(db, email, info) {
  await db.query(
    `INSERT INTO processed_emails
       (gmail_message_id, provider, decision, template, account_last4, amount,
        email_subject, email_from, email_received_at, bill_id, note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
     ON CONFLICT (gmail_message_id) DO UPDATE SET
       decision = excluded.decision, template = excluded.template,
       bill_id = coalesce(excluded.bill_id, processed_emails.bill_id),
       note = excluded.note, processed_at = now()`,
    [email.id, info.provider ?? null, info.decision, info.template ?? null,
     info.account_last4 ?? null, info.amount ?? null,
     email.subject ?? null, email.from ?? null, email.date ?? null,
     info.bill_id ?? null, info.note ?? null]
  );
}

/**
 * Una cuenta nueva se registra sola con la direccion que trae el proveedor.
 * Guarda las dos formas: la canonica para agrupar y la del proveedor para
 * mostrar.
 */
export async function aprenderCuenta(db, registry, item, prop) {
  if (!prop.canonical || !item.account_last4) return false;
  await db.query(
    `INSERT INTO account_registry
       (utility_type, account_last4, provider, property_address, display_address,
        unit, confidence, bills_seen, notes, first_seen_at, last_seen_at)
     VALUES ($1,$2,$3,$4,$5,$6,'provisional',1,$7, now(), now())
     ON CONFLICT (utility_type, account_last4) DO NOTHING`,
    [item.utility_type, item.account_last4, item.provider ?? null,
     prop.canonical, prop.address, prop.unit,
     'Aprendida del propio email del proveedor durante el sync.']
  );
  registry.set(`${item.utility_type}|${item.account_last4}`, {
    property_address: prop.canonical, display_address: prop.address,
    unit: prop.unit, confidence: 'provisional',
  });
  return true;
}

/**
 * Procesa UN email de principio a fin.
 *
 * `lectura` se puede inyectar en los tests; si no viene, se calcula con las
 * reglas de proveedor. `iaFallback` se llama solo con remitentes desconocidos.
 *
 * Devuelve { acciones: [...], billIds: [...], revisar: [...] } — nunca lanza
 * por un email suelto: un email malo no puede tumbar la pasada entera.
 */
export async function procesarEmail({ db, email, registry, lectura, iaFallback }) {
  const out = { acciones: [], billIds: [], revisar: [] };

  let leido = lectura !== undefined ? lectura : extractBill(email);

  if (!leido) {
    if (!iaFallback) {
      out.acciones.push({ decision: 'deferred', motivo: 'remitente desconocido y sin IA disponible' });
      return out;
    }
    try {
      leido = await iaFallback(email);
    } catch (e) {
      await registrarEmail(db, email, { decision: 'error', note: String(e.message ?? e).slice(0, 200) });
      out.acciones.push({ decision: 'error', motivo: String(e.message ?? e) });
      return out;
    }
  }

  const items = leido.kind === 'multi' ? leido.items : [leido];

  for (const item of items) {
    if (item.kind === 'noise') {
      await registrarEmail(db, email, { decision: 'noise', template: item.template, provider: leido.provider });
      out.acciones.push({ decision: 'noise', template: item.template });
      continue;
    }

    if (item.kind === 'payment') {
      const facturaId = await marcarPagada(db, item, email.date);
      await registrarEmail(db, email, {
        decision: 'payment', template: item.template, provider: leido.provider,
        account_last4: item.account_last4, amount: item.amount_due, bill_id: facturaId,
        note: facturaId ? `marcada pagada la factura ${facturaId}` : 'sin factura que casar',
      });
      out.acciones.push({ decision: 'payment', facturaId });
      continue;
    }

    if (item.kind === 'credit') {
      await registrarEmail(db, email, {
        decision: 'credit', template: item.template, provider: leido.provider,
        account_last4: item.account_last4, amount: 0,
        note: `saldo a favor $${item.credit_balance ?? 0}`,
      });
      out.acciones.push({ decision: 'credit' });
      continue;
    }

    // ── factura ────────────────────────────────────────────────────────────
    const prop = resolverPropiedad(registry, item);
    const duplicada = await esDuplicada(db, item, email.date);
    const gmailId = idFactura(email.id, item, items.length);

    const res = await db.query(
      `INSERT INTO utility_bills
         (gmail_message_id, utility_type, property_address, unit, account_last4,
          amount_due, due_date, email_received_at, email_subject, email_from,
          status, is_duplicate, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'pending',$11,'email')
       ON CONFLICT (gmail_message_id) DO NOTHING
       RETURNING id`,
      [gmailId, item.utility_type, prop.address, prop.unit, item.account_last4,
       item.amount_due, item.due_date ?? null, email.date, email.subject ?? null,
       email.from ?? null, duplicada]
    );

    if (!res.rowCount) {
      out.acciones.push({ decision: 'ya-existia', gmailId });
      continue;
    }

    const billId = res.rows[0].id;
    out.billIds.push(billId);

    if (prop.origen === 'email') await aprenderCuenta(db, registry, item, prop);
    if (prop.origen === 'sin asignar') {
      out.revisar.push({ utility_type: item.utility_type, account_last4: item.account_last4, amount: item.amount_due });
    }

    await registrarEmail(db, email, {
      decision: 'bill', template: item.template, provider: leido.provider,
      account_last4: item.account_last4, amount: item.amount_due, bill_id: billId,
      note: [`propiedad desde ${prop.origen}`, duplicada ? 'duplicada' : null, prop.discrepancia]
              .filter(Boolean).join(' · '),
    });

    out.acciones.push({ decision: 'bill', billId, duplicada, origen: prop.origen, discrepancia: prop.discrepancia });
  }

  return out;
}

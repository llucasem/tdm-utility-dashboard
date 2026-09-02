/**
 * Cola de revision (paso 4 del plan post-reset).
 *
 * Para una factura sin pago casado, propone los pagos de QuickBooks que
 * podrian corresponderle — y deja que UNA PERSONA elija. Nada se casa solo:
 * el /roast tumbo el matcher difuso (señales correlacionadas, importes
 * identicos mes a mes) y este es su sustituto deliberado.
 *
 *   GET  ?billId=N          candidatos ordenados por evidencia, con el porque
 *   POST { billId, paymentId }  asigna: manual + locked, como en el registro.
 *                           La decision queda y no se vuelve a preguntar.
 */
import pool from '@/lib/db';
import { normAddress, normUnit } from '@/lib/account-registry';

const PAYEE_TYPE = [
  [/spectrum|charter/i, 'internet'], [/con ?edis/i, 'electricity'],
  [/southern california edison|sce/i, 'electricity'], [/la ?dwp/i, 'electricity'],
  [/socal ?gas/i, 'gas'], [/at&t/i, 'internet'], [/t-?mobile/i, 'internet'],
];

export async function GET(req) {
  try {
    const billId = parseInt(req.nextUrl.searchParams.get('billId') || '', 10);
    if (!billId) return Response.json({ ok: false, error: 'billId required' }, { status: 400 });

    const b = (await pool.query(
      `select id, utility_type, property_address, unit, amount_due, email_received_at
         from utility_bills where id = $1`, [billId])).rows[0];
    if (!b) return Response.json({ ok: false, error: 'bill not found' }, { status: 404 });

    // Pagos SIN asignar en una ventana amplia alrededor de la factura.
    const pagos = (await pool.query(
      `select p.id, p.qb_purchase_id, to_char(p.paid_date,'YYYY-MM-DD') as paid_date, p.amount, p.payee,
              p.qb_class_name, p.bank_account
         from payments p
        where not exists (select 1 from bill_payments bp where bp.payment_id = p.id)
          and p.paid_date between $1::date - 75 and $1::date + 75`,
      [b.email_received_at])).rows;

    // Las Classes de Jake, para saber a que propiedad apunta cada pago.
    const clases = (await pool.query(
      `select qb_class_name, property_address, unit from property_qb_class`)).rows;
    const porClase = new Map(clases.map(c =>
      [c.qb_class_name, { addr: normAddress(c.property_address), unit: normUnit(c.unit) }]));

    const addr = normAddress(b.property_address);
    const unit = normUnit(b.unit);
    const importe = Number(b.amount_due);

    const candidatos = pagos.map(p => {
      const razones = [];
      let score = 0;
      const cls = p.qb_class_name ? porClase.get(p.qb_class_name) : null;
      if (cls && addr && cls.addr === addr) {
        if ((cls.unit || null) === (unit || null)) { score += 4; razones.push(`Jake's class points at this exact unit (${p.qb_class_name})`); }
        else { score += 2; razones.push(`Jake's class points at this building (${p.qb_class_name})`); }
      }
      const tipoPago = PAYEE_TYPE.find(([re]) => re.test(p.payee || ''))?.[1];
      if (tipoPago && tipoPago === b.utility_type) { score += 2; razones.push(`same service type (${p.payee})`); }
      const diff = Math.abs(Number(p.amount) - importe);
      if (diff < 0.005)              { score += 2; razones.push('exact amount'); }
      else if (diff <= importe * 0.5){ score += 1; razones.push(`amount within range (yours $${importe.toFixed(2)}, this $${Number(p.amount).toFixed(2)})`); }
      return { ...p, score, razones, amountDiff: diff };
    })
    .filter(c => c.score >= 2)                       // sin ninguna señal real, fuera
    .sort((a, z) => z.score - a.score || a.amountDiff - z.amountDiff)
    .slice(0, 8);

    return Response.json({ ok: true, bill: { id: b.id }, candidates: candidatos });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

export async function POST(req) {
  try {
    const { billId, paymentId } = await req.json();
    if (!billId || !paymentId) {
      return Response.json({ ok: false, error: 'billId and paymentId required' }, { status: 400 });
    }

    // Un pago solo salda una factura, salvo que una persona reparta a mano.
    const taken = await pool.query(
      `select bill_id from bill_payments where payment_id = $1 limit 1`, [paymentId]);
    if (taken.rowCount > 0 && taken.rows[0].bill_id !== billId) {
      return Response.json({ ok: false, error: `payment already assigned to bill #${taken.rows[0].bill_id}` }, { status: 409 });
    }

    // La decision humana: manual + locked. Ninguna pasada automatica la pisa.
    await pool.query(
      `insert into bill_payments (bill_id, payment_id, allocated_amount, source, locked)
       values ($1, $2, null, 'manual', true)
       on conflict (bill_id, payment_id) do update set source = 'manual', locked = true`,
      [billId, paymentId]);
    await pool.query(`update utility_bills set status = 'paid' where id = $1`, [billId]);

    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

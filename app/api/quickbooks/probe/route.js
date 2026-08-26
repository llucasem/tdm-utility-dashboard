/**
 * Diagnostico: ¿que objetos usa de verdad este QuickBooks?
 *
 * La pregunta decide la arquitectura del "pagado vs facturado":
 *
 *   Si hay objetos Bill + BillPayment -> QuickBooks YA guarda que pago salda
 *     que factura (LinkedTxn) y cuanto queda pendiente (Bill.Balance, que el
 *     propio QB calcula). El importe pagado se LEE, no se deduce.
 *
 *   Si solo hay Purchase (gasto/cheque directo, que no pasa por cuentas a
 *     pagar) -> ese enlace no existe en QuickBooks porque nunca se introdujo,
 *     y ninguna heuristica lo puede reconstruir con garantias.
 */
import { queryQB } from '@/lib/quickbooks';

export const maxDuration = 60;

export async function GET() {
  const desde = new Date(Date.now() - 120 * 86_400_000).toISOString().slice(0, 10);
  const out = {};

  const contar = async (entidad, where) => {
    try {
      const r = await queryQB(`SELECT COUNT(*) FROM ${entidad}${where ? ' WHERE ' + where : ''}`);
      return r?.QueryResponse?.totalCount ?? 0;
    } catch (e) {
      return { error: e.message?.slice(0, 120) };
    }
  };

  out.conteos = {
    Purchase:    await contar('Purchase', `TxnDate >= '${desde}'`),
    Bill:        await contar('Bill', `TxnDate >= '${desde}'`),
    BillPayment: await contar('BillPayment', `TxnDate >= '${desde}'`),
  };

  // ¿Alguna Bill de un proveedor de servicios, y trae Balance/LinkedTxn?
  try {
    const r = await queryQB(`SELECT * FROM Bill WHERE TxnDate >= '${desde}' MAXRESULTS 20`);
    const bills = r?.QueryResponse?.Bill || [];
    out.ejemploBills = bills.slice(0, 8).map(b => ({
      id: b.Id, fecha: b.TxnDate, proveedor: b.VendorRef?.name,
      total: b.TotalAmt, pendiente: b.Balance,
      enlaces: (b.LinkedTxn || []).map(l => `${l.TxnType}:${l.TxnId}`),
    }));
    out.billsConSaldoParcial = bills.filter(b =>
      Number(b.Balance) > 0 && Number(b.Balance) < Number(b.TotalAmt)).length;
  } catch (e) { out.ejemploBills = { error: e.message?.slice(0, 160) }; }

  // LA PREGUNTA QUE DECIDE: ¿los proveedores de SERVICIOS se meten como Bill
  // (pasa por cuentas a pagar, hay enlace al pago) o como Purchase (gasto
  // directo, sin enlace)?
  const ES_SERVICIO = /spectrum|con ?edis|southern california edison|ladwp|socal ?gas|at&t|t-?mobile|verizon|frontier|optimum|national grid/i;

  const traer = async (entidad, campoProveedor) => {
    const filas = [];
    let pos = 1;
    while (pos <= 2000) {
      const r = await queryQB(`SELECT * FROM ${entidad} WHERE TxnDate >= '${desde}' STARTPOSITION ${pos} MAXRESULTS 500`);
      const items = r?.QueryResponse?.[entidad] || [];
      filas.push(...items);
      if (items.length < 500) break;
      pos += items.length;
    }
    const cuenta = {};
    for (const f of filas) {
      const nombre = f[campoProveedor]?.name || '(sin proveedor)';
      if (!ES_SERVICIO.test(nombre)) continue;
      cuenta[nombre] = (cuenta[nombre] || 0) + 1;
    }
    return { total: filas.length, deServicios: cuenta };
  };

  try {
    out.bills     = await traer('Bill', 'VendorRef');
    out.purchases = await traer('Purchase', 'EntityRef');
  } catch (e) { out.porProveedor = { error: e.message?.slice(0, 160) }; }

  // ¿Los BillPayment dicen que factura saldan?
  try {
    const r = await queryQB(`SELECT * FROM BillPayment WHERE TxnDate >= '${desde}' MAXRESULTS 10`);
    out.ejemploBillPayments = (r?.QueryResponse?.BillPayment || []).slice(0, 5).map(p => ({
      id: p.Id, fecha: p.TxnDate, proveedor: p.VendorRef?.name, total: p.TotalAmt,
      salda: (p.Line || []).flatMap(l => (l.LinkedTxn || []).map(t => `${t.TxnType}:${t.TxnId}`)),
    }));
  } catch (e) { out.ejemploBillPayments = { error: e.message?.slice(0, 160) }; }

  return Response.json({ ok: true, desde, ...out });
}

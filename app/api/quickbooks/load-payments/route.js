/**
 * Carga profunda del libro de pagos.
 *
 * Recorre las Purchases de QuickBooks hacia atras y registra cada pago de un
 * proveedor de servicios como HECHO en `payments` — sin crear ninguna factura
 * (maxCreates: 0). Es lo que da candidatos a la cola de revision.
 *
 * El cron nocturno mantiene la ventana corta (35 dias); esta ruta existe para
 * la carga inicial y para recuperaciones: /api/quickbooks/load-payments?days=120
 */
import { backfillBillsFromQB } from '@/lib/qb-backfill';

export const maxDuration = 60;

export async function GET(req) {
  try {
    const days = Math.min(parseInt(req.nextUrl.searchParams.get('days') || '120', 10) || 120, 365);
    const stats = await backfillBillsFromQB({ sinceDays: days, maxCreates: 0 });
    return Response.json({ ok: true, days, ...stats });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

import pool from '@/lib/db';
import { autoTagBill, autoTagBatch } from '@/lib/auto-tag';
import { createNotification } from '@/lib/notifier';

/** GET /api/quickbooks/auto-tag?billId=123  → tag a single bill */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const billId = parseInt(searchParams.get('billId'), 10);
    if (!billId) return Response.json({ ok: false, error: 'billId required' }, { status: 400 });

    const r = await pool.query(`SELECT id, amount_due, due_date, email_received_at, property_address, unit FROM utility_bills WHERE id = $1`, [billId]);
    if (r.rows.length === 0) return Response.json({ ok: false, error: 'Bill not found' }, { status: 404 });

    const result = await autoTagBill(r.rows[0]);
    return Response.json({ ok: true, result });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

/** POST /api/quickbooks/auto-tag  body { billIds: [...] } */
export async function POST(request) {
  try {
    const { billIds } = await request.json();
    const stats = await autoTagBatch(billIds);

    if (stats.tagged > 0 || stats.error > 0 || stats.ambiguous > 0) {
      const parts = [];
      if (stats.tagged > 0)    parts.push(`✓ ${stats.tagged} tagged`);
      if (stats.ambiguous > 0) parts.push(`⚠ ${stats.ambiguous} ambiguous`);
      if (stats.not_found > 0) parts.push(`✗ ${stats.not_found} not found`);
      if (stats.error > 0)     parts.push(`! ${stats.error} errors`);

      await createNotification({
        type:    stats.error > 0 ? 'error' : (stats.ambiguous > 0 ? 'warning' : 'success'),
        title:   `Auto-tag: ${parts.join(' · ')}`,
        message: `Processed ${stats.items.length} bills against QuickBooks. Open the dashboard to review.`,
        metadata: { stats: { tagged: stats.tagged, ambiguous: stats.ambiguous, not_found: stats.not_found, error: stats.error } },
      });
    }

    return Response.json({ ok: true, ...stats });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

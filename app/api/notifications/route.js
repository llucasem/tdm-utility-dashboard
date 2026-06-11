import { listNotifications, getUnreadCount, markAllRead, createNotification } from '@/lib/notifier';

/** GET /api/notifications  — list (with unread count) */
export async function GET(request) {
  try {
    const { searchParams } = new URL(request.url);
    const limit      = Math.min(parseInt(searchParams.get('limit') || '50', 10), 200);
    const unreadOnly = searchParams.get('unread') === 'true';

    const [items, unreadCount] = await Promise.all([
      listNotifications({ limit, unreadOnly }),
      getUnreadCount(),
    ]);

    return Response.json({ ok: true, items, unreadCount });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

/** POST /api/notifications  body { action: 'markAllRead' } */
export async function POST(request) {
  try {
    const { action } = await request.json();
    if (action === 'markAllRead') {
      const updated = await markAllRead();
      return Response.json({ ok: true, updated });
    }
    // End-to-end test of the alert pipeline: creates a real 'error'
    // notification, which also fires the WhatsApp webhook (Jarvis).
    // Reachable only with valid session or CRON_SECRET (middleware).
    if (action === 'testAlert') {
      const n = await createNotification({
        type:    'error',
        title:   '🧪 Test de alertas',
        message: 'Prueba del canal de alertas dashboard → WhatsApp. Si lees esto en WhatsApp, el circuito de producción funciona.',
      });
      return Response.json({ ok: true, id: n.id });
    }
    return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

import { listNotifications, getUnreadCount, markAllRead } from '@/lib/notifier';

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
    return Response.json({ ok: false, error: 'Unknown action' }, { status: 400 });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

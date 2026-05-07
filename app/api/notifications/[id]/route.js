import { markRead } from '@/lib/notifier';

/** PATCH /api/notifications/:id  — mark a single notification as read */
export async function PATCH(_request, { params }) {
  try {
    const { id } = await params;
    await markRead(parseInt(id, 10));
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

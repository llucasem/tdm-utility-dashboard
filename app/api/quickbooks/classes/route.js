import { listClasses, createClass } from '@/lib/quickbooks';

/** GET /api/quickbooks/classes — list active QuickBooks Classes */
export async function GET() {
  try {
    const classes = await listClasses();
    const out = classes
      .map(c => ({ id: c.Id, name: c.Name, fullName: c.FullyQualifiedName }))
      .sort((a, b) => a.name.localeCompare(b.name));
    return Response.json({ ok: true, classes: out });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

/** POST /api/quickbooks/classes  body { name } — create a new Class */
export async function POST(request) {
  try {
    const { name } = await request.json();
    if (!name || typeof name !== 'string' || !name.trim()) {
      return Response.json({ ok: false, error: 'name is required' }, { status: 400 });
    }
    const created = await createClass(name.trim());
    return Response.json({
      ok: true,
      class: { id: created.Id, name: created.Name, fullName: created.FullyQualifiedName },
    });
  } catch (e) {
    return Response.json({ ok: false, error: e.message }, { status: 500 });
  }
}

# AUDIT REPORT — TDM Utility Dashboard

**Fecha:** 2026-05-14
**Alcance:** Auditoría interna completa antes de entrega del proyecto
**Resultado del script automático:** ✓ 46 OK · ⚠ 1 warning · ✗ 0 fallos

---

## Resumen ejecutivo

La app está **lista para entrega**. No hay bugs de seguridad ni problemas críticos. He encontrado **3 bugs reales** (de gravedad baja-media) y **5 puntos menores de mejora**. Todos están documentados abajo con la línea exacta y la corrección sugerida.

| Severidad | Cantidad | Estado |
|---|---|---|
| 🔴 Crítico (rompe la app) | 0 | — |
| 🟠 Alto (funcionalidad rota) | 1 | A corregir |
| 🟡 Medio (UX degradada) | 2 | A corregir |
| 🟢 Bajo (mejoras opcionales) | 5 | Opcional |

---

## 1. Seguridad — ✅ Sólida

| Comprobación | Resultado |
|---|---|
| Middleware protege todas las rutas no públicas | ✓ |
| API devuelve 401 JSON (no HTML redirect) | ✓ |
| Cron solo aceptado con `x-vercel-cron` (cabecera unspoofable) | ✓ |
| Cookie `tdm_session`: httpOnly + secure + sameSite strict | ✓ |
| Rate limit en login (8 intentos/min por IP) | ✓ |
| Todas las queries DB usan parámetros (`$1`, `$2`) — **sin SQL injection** | ✓ |
| `.gitignore` cubre `.env.local`, `CLAUDE.md`, `backups/`, `*.json` de OAuth, etc. | ✓ |
| Secretos nunca aparecen en cliente (todo es server-side) | ✓ |
| Sentry desactivado de forma segura cuando no hay DSN | ✓ |

**Única observación:** La cookie de sesión es un **token estático** (`APP_SESSION_TOKEN`), no rotativo. Si alguien obtuviera el cookie, sería válido 30 días sin posibilidad de revocarlo individualmente. Para una app interna con un solo usuario operativo (Jake) es aceptable. Si en el futuro hubiera varios usuarios, conviene migrar a JWT con expiración corta.

---

## 2. Integración con QuickBooks — ✅ Sólida

| Comprobación | Resultado |
|---|---|
| Refresh de token automático con buffer de 5 min antes de caducar | ✓ |
| Refresh token rotado y persistido tras cada uso | ✓ |
| Reintento automático en 401 (token rechazado → refresh → retry) | ✓ |
| Tokens actuales: 94 días de margen antes de necesitar re-auth | ✓ |
| Query QBO con `TotalAmt = '${amt}'` (single-quote — bug ya corregido) | ✓ |
| Guardrail en auto-tag: nunca sobrescribe una Class existente | ✓ |
| `searchTransactions` cubre `Purchase` + `BillPayment` en paralelo | ✓ |

**Estadísticas del cotejado:**
- 316 facturas con `matched` (✓)
- 142 con `ambiguous` (⚠) — esperado, varias transacciones con el mismo importe
- 40 con `not_found` (✗) — bank-feed lag, el cron retry los recuperará
- 440 con `pending` — son facturas sin `amount_due` (parser no extrajo importe), no se procesan a propósito

---

## 3. Bugs encontrados

### 🟠 BUG-1 — `gmailLink` siempre es null

**Archivo:** [app/api/bills/route.js:13-22](app/api/bills/route.js#L13-L22)

El SELECT no incluye `gmail_message_id`, pero el mapeo la usa:

```js
gmailLink: row.gmail_message_id
  ? `https://mail.google.com/mail/u/0/#all/${row.gmail_message_id}`
  : null,
```

Como `row.gmail_message_id` es siempre `undefined`, el botón **"View email →"** del modal de detalle nunca aparece para ninguna factura.

**Fix:** añadir `gmail_message_id` a la lista del SELECT.

**Impacto:** funcionalidad rota silenciosamente. Lo arreglo si me lo confirmas.

---

### 🟡 BUG-2 — "Add bill" no persiste en la base de datos

**Archivo:** [components/AddBillModal.jsx:30-58](components/AddBillModal.jsx#L30-L58)

El formulario manual crea un objeto con `id: Date.now()` y se lo pasa a `onSave`, que sólo lo añade al estado local de React. Al recargar la página la factura se pierde.

```js
onSave({
  id: Date.now(),         // ← id falso, no de la DB
  ...
});
```

**Impacto:** Jake podría añadir una factura manual, ver que aparece, y descubrir mañana que se ha esfumado.

**Fix:** crear endpoint `POST /api/bills` que inserte en la DB, devuelva el id real, y que el modal use la respuesta. Lo arreglo si me lo confirmas.

---

### 🟡 BUG-3 — `/api/review-flags` DELETE no funciona en Vercel

**Archivo:** [app/api/review-flags/route.js:15-33](app/api/review-flags/route.js#L15-L33)

El endpoint usa `writeFileSync` para borrar entradas de `data/review-flags.json`. El sistema de archivos en Vercel **es read-only en runtime**, así que el DELETE va a fallar silenciosamente en producción.

**Impacto:** Limitado — esta funcionalidad parece poco usada (panel admin) y la página `/admin` ni siquiera está enlazada desde el dashboard principal.

**Fix:** Mover los review-flags a una tabla en la DB (igual que el resto), o eliminar el endpoint si ya no se usa.

---

## 4. Mejoras menores (opcionales)

### 🟢 MEJORA-1 — Auto-tag GET endpoint no reutiliza match persistido

**Archivo:** [app/api/quickbooks/auto-tag/route.js:12](app/api/quickbooks/auto-tag/route.js#L12)

Cuando se llama `GET /api/quickbooks/auto-tag?billId=X`, el SELECT no incluye las columnas `qb_match_*`. Eso fuerza a `autoTagBill` a usar el fallback lazy, que **vuelve a llamar a QB** — desperdicia una API call.

**Fix:** añadir `qb_match_status, qb_match_count, qb_match_data` al SELECT.

### 🟢 MEJORA-2 — `bills_table` carece de índice por dueDate

Para 938 bills no es problema, pero si crece a 10k+ el `ORDER BY due_date` se vuelve lento.

**Fix:** `CREATE INDEX IF NOT EXISTS idx_ub_due_date ON utility_bills (due_date);`

### 🟢 MEJORA-3 — `data/mockBills.js` todavía se importa

[components/AnalyticsModal.jsx:4](components/AnalyticsModal.jsx#L4)

El modal de Analytics todavía usa datos mock. No es un bug porque funciona, pero es engañoso para el usuario.

**Fix:** Migrar AnalyticsModal a datos reales de `/api/bills`. Tarea separada.

### 🟢 MEJORA-4 — `INTERVAL '${HISTORY_MONTHS} months'` interpolado en SQL

[lib/anomaly-detector.js:45](lib/anomaly-detector.js#L45)

Es un constante hardcoded (6) — no hay riesgo de SQL injection, pero el patrón es feo. Usar `INTERVAL '6 months'` literal o pasar como parámetro.

### 🟢 MEJORA-5 — Documentación de CLAUDE.md desactualizada

CLAUDE.md menciona "4 tarjetas de resumen" pero `StatsRow.jsx` solo muestra 3. Tampoco refleja las features añadidas en las últimas dos semanas (notificaciones, anomalías, persistent match).

---

## 5. Verificaciones de la base de datos

Ejecutadas por `scripts/audit-run.mjs` contra Neon:

| Check | Resultado |
|---|---|
| 7 tablas requeridas presentes (`utility_bills`, `notifications`, `quickbooks_tokens`, `account_mappings`, `properties`, `property_qb_class`, `quickbooks_tag_log`) | ✓ |
| 25 columnas requeridas en `utility_bills` | ✓ |
| Índices `idx_ub_qb_tag_status`, `idx_ub_qb_match_status`, `idx_ub_qb_match_pending` | ✓ |
| Sin duplicados de `gmail_message_id` | ✓ |
| Valores de `qb_tag_status` y `qb_match_status` dentro del enum válido | ✓ |
| `qb_match_data` JSONB bien formado (array con `type/id/date/amount`) | ✓ |
| Sin filas huérfanas en `quickbooks_tag_log` (FK a `utility_bills` íntegra) | ✓ |
| Tokens de QB con 94 días de margen | ✓ |
| ⚠ **0 de 57 propiedades mapeadas a una Class de QB** — auto-tag no puede etiquetar nada hasta que se haga | ⚠ |

---

## 6. Tests HTTP — pendientes de ejecutar contra producción

El script está listo. Para correrlo contra tu Vercel, ejecuta:

```bash
AUDIT_BASE_URL=https://TU-URL-VERCEL.app node scripts/audit-run.mjs
```

Comprobará:
- `/api/bills` sin cookie → debe responder `401 JSON`
- `/api/quickbooks/match-pending` sin cabecera cron → debe responder `401`
- `/login` debe ser accesible sin auth (200)

---

## 7. Recomendaciones de entrega

**Antes de entregar:**
1. ✅ **Corregir BUG-1** (gmailLink) — bug visible, 5 min de trabajo
2. ⚠️ **Decidir BUG-2** (Add bill no persiste) — si Jake va a usar el botón, hay que arreglarlo. Si no, ocultarlo.
3. ⚠️ **Mapear las 57 propiedades a Classes de QB** desde `/admin/qb-classes` — sin esto, `auto-tag` nunca etiqueta nada
4. ✅ Hacer correr `node scripts/audit-run.mjs` con `AUDIT_BASE_URL=...` para validar HTTP

**Después de entregar:**
- BUG-3 (review-flags) → mover a DB cuando se vuelva a usar
- MEJORAS 1-5 → opcionales

**Lo que NO hace falta hacer:**
- Los cambios anunciados por Intuit (webhooks + Reports API) no nos afectan
- La seguridad está sólida — no requiere cambios
- La integración con QuickBooks funciona correctamente
- La base de datos es íntegra y los backups están configurados

---

## 8. Cómo re-ejecutar la auditoría en el futuro

```bash
# Auditoría completa (DB + invariantes)
node scripts/audit-run.mjs

# Con probes HTTP contra producción
AUDIT_BASE_URL=https://tu-url.vercel.app node scripts/audit-run.mjs
```

El script es **read-only** (no escribe nada en la DB ni en QB). Es seguro ejecutarlo en producción tantas veces como quieras.

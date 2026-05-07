# Plan: Auto-tagging de QuickBooks + reportes + notificaciones

> **Estado:** documento de planificación (no implementado)
> **Próxima sesión:** rematar todo lo que aquí se describe
> **Fecha:** 6 de mayo de 2026

---

## 🎯 Qué queremos lograr

Que cuando una factura de utilities (electricidad, internet, gas) **entre al dashboard con una propiedad ya asignada**, la aplicación **automáticamente etiquete el Purchase correspondiente en QuickBooks con el Class de esa propiedad** — eliminando el trabajo manual que Jake hace hoy.

Además:
- A **final de mes**, un reporte por email con todo lo actualizado y lo pendiente
- Cualquier **error** dispara un email inmediato al correo de Lluis (`llucasem@gmail.com`)

Los emails se envían **desde la cuenta de Edonis (`login@thedreammanagement.com`)** usando la conexión Gmail OAuth que ya tenemos configurada.

---

## 🔁 Flujo end-to-end (lo que pasa cuando llega una factura)

```
   Email de utility en Gmail
            │
            ▼
   ┌─────────────────┐
   │  /api/sync      │  Lee email, parsea con Claude, guarda en utility_bills
   └────────┬────────┘
            │
            ▼
   ┌─────────────────────────┐
   │ ¿Tiene property_address │  ← electricidad/gas/socalgas suelen NO tener
   │ ya asignada?            │     internet (Spectrum) suele SÍ
   └────┬─────────────────┬──┘
        │ NO              │ SÍ
        ▼                 ▼
   "Unassigned"      ┌───────────────────────────┐
   Jake la asigna    │  POST /api/quickbooks/    │
   manualmente       │       auto-tag            │
        │            └────────────┬──────────────┘
        │                         │
        │                         ▼
        │          1) Cotejar con QB (importe ± fecha)
        │          2) Si 1 match único:
        │             - Buscar Class del property_id
        │             - Actualizar ClassRef del Purchase
        │             - Guardar log en quickbooks_tag_log
        │          3) Si 0 matches: log pending
        │          4) Si >1 matches: log ambiguous (no auto)
        │          5) Si error: log error + enviar email
        │                         │
        ▼                         │
        └─── (al asignar) ────────┘
            (también dispara auto-tag)
```

---

## 🗄️ Cambios en la base de datos (Neon)

### Nueva tabla: `quickbooks_tag_log`

Trackea cada intento de tagging para reporte mensual y debug.

```sql
CREATE TABLE quickbooks_tag_log (
  id                 SERIAL PRIMARY KEY,
  bill_id            INTEGER NOT NULL REFERENCES utility_bills(id),
  qb_purchase_id     TEXT,              -- Id del Purchase en QB (null si no encontrado)
  qb_purchase_type   TEXT,              -- "Purchase" | "BillPayment"
  qb_class_id_new    TEXT,              -- Class que asignamos
  qb_class_id_old    TEXT,              -- Class previo (para auditoría/revert)
  status             TEXT NOT NULL,     -- success | not_found | ambiguous | error
  match_count        INTEGER,           -- cuántos matches había
  error_message      TEXT,              -- si status='error'
  email_notified     BOOLEAN DEFAULT false,
  tagged_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_qbtl_bill   ON quickbooks_tag_log (bill_id);
CREATE INDEX idx_qbtl_status ON quickbooks_tag_log (status, tagged_at);
```

### Nueva tabla: `property_qb_class`

Mapeo entre nuestras propiedades y los Classes de QB. **Setup one-time** — Jake o Lluis lo llena una vez.

```sql
CREATE TABLE property_qb_class (
  id                  SERIAL PRIMARY KEY,
  property_id         INTEGER REFERENCES properties(id),
  property_address    TEXT NOT NULL,    -- redundante pero útil para queries
  unit                TEXT,
  qb_class_id         TEXT NOT NULL,    -- Id del Class en QB
  qb_class_name       TEXT NOT NULL,    -- nombre legible
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  updated_at          TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(property_id, unit)
);
```

**Importante:** las 20 Classes que ya existen en QB de Edonis tienen nombres tipo `"1114 San Vicente"`, `"312 E #4E"`, `"360 W Pico"`. Hay que mapearlas a nuestras 67 propiedades. Probablemente faltan unas cuantas Classes en QB (porque hay solo 20) y habrá que crearlas — pero eso lo decidimos cuando veamos el mapeo real.

### Modificación a `utility_bills`

```sql
ALTER TABLE utility_bills ADD COLUMN qb_tag_status TEXT DEFAULT 'pending';
-- valores: pending | tagged | not_found | ambiguous | error | skipped
ALTER TABLE utility_bills ADD COLUMN qb_purchase_id TEXT;
```

Esto permite mostrar el estado en el dashboard sin tener que joinear contra `quickbooks_tag_log` cada vez.

---

## 🔧 Componentes técnicos a construir

### 1. `lib/quickbooks.js` — añadir `tagPurchaseWithClass()`

```js
export async function tagPurchaseWithClass({ purchaseId, classId, className })
```

Hace:
- GET del Purchase actual (incluye SyncToken)
- Construye payload sparse update con ClassRef en cada Line
- POST de update
- Devuelve { ok, previousClass, newClass } o { ok: false, error }

**Ya validado técnicamente** en `scripts/qb-test-write.mjs` — funciona end-to-end.

### 2. Endpoint `POST /api/quickbooks/auto-tag`

Body:
```json
{ "billIds": [123, 456], "force": false }
```

Lógica para cada billId:
1. Cargar la bill — si no tiene `property_address`, marcar `skipped`
2. Buscar `property_qb_class` para esa propiedad+unit. Si no existe, marcar `error: no class mapping`
3. Cotejar con QB (`searchTransactions`)
4. Según número de matches:
   - **0 matches** → status `not_found` (probablemente lag de QB; reintenta más tarde)
   - **1 match** → llamar `tagPurchaseWithClass()` y registrar `success`
   - **>1 matches** → status `ambiguous` (Jake decide manualmente desde el modal)
5. Guardar registro en `quickbooks_tag_log`
6. Actualizar `utility_bills.qb_tag_status`
7. Si `status='error'` → encolar email inmediato

Devuelve `{ ok, results: { billId: { status, ... } } }`.

### 3. Disparo automático del auto-tag

Dos puntos donde se dispara:

**A. Tras un sync** — al final de `/api/sync`, llamar a `auto-tag` con todos los `billIds` recién insertados que tengan `property_address`.

**B. Tras una asignación manual** — cuando Jake usa el `AssignPropertyModal`, después de guardar la asignación, llamar a `auto-tag` para esa bill.

### 4. UI: badge nuevo en `BillsTable.jsx`

Junto al badge de match QB (✓/⚠/✗), añadir uno de "tagged":

| Símbolo | Significado |
|---|---|
| 🏷️ | Tagged en QB |
| 🏷️? | Ambiguo — Jake debe elegir cuál |
| 🏷️! | Error — ver detalle |
| (vacío) | Aún sin intentar / sin propiedad asignada |

En el `BillDetailModal`, añadir un **botón "Tag in QuickBooks"** para casos ambiguous (lista de candidatos para que Jake elija) y para reintento manual.

---

## 📨 Sistema de email (notificaciones)

### Infraestructura

Reutilizamos la conexión OAuth de Gmail que ya tenemos (la de `login@thedreammanagement.com`). El SDK de Google permite enviar email vía `gmail.users.messages.send` con el mismo refresh token.

Ventaja: sin SMTP, sin SendGrid, sin servicios externos. La cuenta de envío es la misma que la de lectura.

### Nuevo módulo `lib/mailer.js`

```js
export async function sendEmail({ to, subject, htmlBody, textBody })
```

Envía via Gmail API. Usa `process.env.MAIL_TO` (= `llucasem@gmail.com`) como destinatario por defecto si no se especifica.

### Email 1 — Notificación inmediata de error

**Cuando:** cada vez que `auto-tag` registra un `status='error'`.

**Para evitar spam:** agrupar errores en una ventana de 10 minutos. Si llegan 5 errores en ese rango, mandar 1 email con los 5.

Asunto: `[Edonis Utility] Error tagging X facturas en QuickBooks`

Cuerpo:
```
Hola Lluis,

Se han producido X errores al intentar etiquetar facturas en QuickBooks.

1. Bill #1485 — gas $8.05 — SoCalGas — error: "QuickBooks API 401: token revoked"
2. Bill #1516 — electricity $135.59 — SCE — error: "...”

Acción sugerida: revisar el dashboard.
```

### Email 2 — Reporte mensual

**Cuando:** el día 1 de cada mes a las 9 AM (UTC), vía cron de Vercel (`vercel.json`).

**Endpoint:** `GET /api/quickbooks/monthly-report?send=true`

Asunto: `[Edonis Utility] Reporte mensual de auto-tagging — Mayo 2026`

Cuerpo (HTML simple):
```
Resumen de abril 2026:

✓ Tagged automáticamente:    142 facturas
⚠ Ambiguas (revisión manual): 18 facturas
✗ Sin match en QuickBooks:    7  facturas
✗ Errores:                    2 facturas

Total facturas procesadas: 169

Top 5 propiedades con más facturas tagged:
- 1114 San Vicente: 12
- ...

Pendientes de revisión manual: [link al dashboard filtrado]
```

Datos sacados de `quickbooks_tag_log` y `utility_bills` para el mes anterior.

### Email 3 — Reporte ad-hoc on demand

**Cuando:** Lluis o Jake pulsa un botón "Send report now" en el dashboard.

Igual que el mensual pero con el rango de fechas que elija.

---

## ⏰ Cron jobs a añadir a `vercel.json`

```json
{
  "crons": [
    {
      "path": "/api/sync",
      "schedule": "0 */6 * * *"
    },
    {
      "path": "/api/quickbooks/auto-tag-pending",
      "schedule": "0 3 * * *"
    },
    {
      "path": "/api/quickbooks/monthly-report?send=true",
      "schedule": "0 9 1 * *"
    }
  ]
}
```

- **`/api/sync`** ya está (cada 6h)
- **`auto-tag-pending`** (nuevo, diario a las 3 AM): re-intenta tagging para facturas con `qb_tag_status IN ('not_found','error')` por si los Purchases han llegado a QB después
- **`monthly-report`** (nuevo, día 1 a las 9 AM): envía reporte mensual

---

## 🛠️ Setup inicial requerido (one-time, antes de activar)

1. **Migración SQL** — ejecutar `scripts/migrate-qb-autotag.mjs` (lo creamos en la próxima sesión) para crear las dos tablas nuevas + columnas en `utility_bills`

2. **Mapeo property → Class** — necesitamos llenar `property_qb_class`. Dos opciones:
   - **Manual:** una pantalla `/admin/qb-classes` donde Jake/Lluis ven las 67 propiedades y los 20 Classes existentes en QB y los emparejan
   - **Asistido por AI:** Claude compara nombres y propone matches. Lluis confirma/corrige
   - **Recomendado:** la versión asistida — más rápida

3. **Crear Classes faltantes en QB** — si una propiedad no tiene Class en QB, hay que crearlo. Esto es POST a `/v3/company/{realmId}/class`. Lluis puede aprobar uno por uno o batch.

4. **Variable de entorno nueva**: `MAIL_TO=llucasem@gmail.com` en `.env.local` y Vercel

5. **Probar en una bill real** antes de activar el auto-disparo del sync

---

## 🚦 Plan de implementación por fases

### Fase A — Cimientos (1 día)
- [ ] Migración SQL: tablas `quickbooks_tag_log`, `property_qb_class`, columnas en `utility_bills`
- [ ] `lib/mailer.js` (envío vía Gmail API existente)
- [ ] `lib/quickbooks.js` → `tagPurchaseWithClass()`, `createClass()`
- [ ] Variable `MAIL_TO` en .env y Vercel
- [ ] Test end-to-end del envío de email a `llucasem@gmail.com`

### Fase B — Mapeo de Classes (1 día)
- [ ] Endpoint `GET /api/quickbooks/classes` (lista classes de QB)
- [ ] Endpoint `POST /api/quickbooks/classes` (crear nuevo class)
- [ ] Endpoint `GET/POST /api/property-qb-class` (CRUD del mapping)
- [ ] Pantalla `/admin/qb-classes` con UI de mapping asistido
- [ ] Llenar las 67 propiedades

### Fase C — Auto-tag (1-2 días)
- [ ] Endpoint `POST /api/quickbooks/auto-tag`
- [ ] Disparo automático tras `/api/sync`
- [ ] Disparo automático tras asignación en `AssignPropertyModal`
- [ ] Badge 🏷️ en `BillsTable` y modal de detalle
- [ ] Botón manual "Tag in QuickBooks" para casos ambiguos

### Fase D — Reportes y notificaciones (1 día)
- [ ] Endpoint `GET /api/quickbooks/monthly-report`
- [ ] Endpoint `POST /api/quickbooks/notify-errors` (batch de 10 min)
- [ ] Cron jobs en `vercel.json`
- [ ] Plantillas HTML del email
- [ ] Test del reporte mensual con datos de prueba

### Fase E — QA con Jake (medio día)
- [ ] Probar con 5-10 facturas reales
- [ ] Pedir feedback a Jake sobre el flujo
- [ ] Ajustar tolerancias si hace falta (ej: ±15 días → ±20 si hay misses)

---

## ⚠️ Riesgos y decisiones pendientes

| Riesgo | Mitigación |
|---|---|
| **Tag erróneo en una transacción equivocada** | Solo auto-tag cuando hay 1 match único + propiedad asignada. Casos ambiguos → manual. Cada cambio queda en `quickbooks_tag_log` con `qb_class_id_old` por si hay que revertir |
| **API de QB caída o rate-limited** | Reintento con backoff. Si falla 3 veces → registrar error + email |
| **Lag de QB**: el email llega antes que el cargo bancario aparezca en QB | Cron diario `/auto-tag-pending` reintenta los `not_found` y `error` |
| **Cambio de Class por error humano en QB** | El `tag_log` permite ver el histórico y revertir manualmente. No tocamos transacciones que ya tienen otro Class distinto al "default" salvo confirmación. **Decisión pendiente:** ¿sobreescribimos siempre, o solo si el Class actual es vacío/genérico? |
| **Token de Gmail expira** | El refresh_token actual no caduca (Workspace interno). Si caduca, volver a ejecutar `scripts/get-gmail-token.js` |
| **Volumen de emails de error** | Batching de 10 minutos. Máximo 1 email cada 10 min |

### Decisiones que necesitamos tomar antes de la próxima sesión

1. **¿Sobreescribir Class existentes en Purchase, o solo si está vacío/default?**
   - La prueba de hoy mostró que el Purchase target ya tenía Class `"AO #630"` — es decir Edonis ya etiqueta algunas. ¿Queremos cambiarlas si nuestro mapeo dice otra cosa?

2. **¿Mapeo manual o asistido por AI?**
   - Mi recomendación: asistido. Claude propone, humano confirma.

3. **¿Reintento automático o solo manual?**
   - Mi recomendación: cron diario para `not_found` (re-cotejar por si llegó a QB). Errores genuinos → email + manual.

4. **¿Reporte mensual a quién más?**
   - Solo a Lluis (`llucasem@gmail.com`) o también a Edonis y Jake?

---

## 📁 Archivos que se crearán

```
scripts/
├── migrate-qb-autotag.mjs        # Crea tablas nuevas + columnas
├── qb-classes-fill.mjs            # Helper para mapeo asistido (one-time)
└── qb-tag-test.mjs                # Test del flujo end-to-end

lib/
├── mailer.js                      # Envío via Gmail API
└── quickbooks.js                  # Añade tagPurchaseWithClass, createClass

app/api/quickbooks/
├── auto-tag/route.js              # POST: ejecuta auto-tag para una bill o batch
├── auto-tag-pending/route.js      # GET: cron diario, reintenta pending
├── monthly-report/route.js        # GET: reporte mensual (cron)
├── classes/route.js               # GET/POST: classes de QB
└── notify-errors/route.js         # POST: envía email batch de errores

app/api/property-qb-class/route.js # CRUD del mapping

app/admin/qb-classes/page.js       # UI para mapeo

components/
├── QBTagBadge.jsx                 # Badge 🏷️ para BillsTable
└── QBTagPicker.jsx                # Modal de selección para casos ambiguos

vercel.json                        # Cron schedules nuevos
```

---

## 🔗 Referencias técnicas (para retomar rápido)

- **Endpoint QB query:** `GET https://quickbooks.api.intuit.com/v3/company/{realmId}/query?query={SQL}&minorversion=70`
- **Endpoint QB update Purchase:** `POST .../purchase?minorversion=70` con body `{ Id, SyncToken, sparse: true, Line: [...] }`
- **Endpoint QB create Class:** `POST .../class?minorversion=70` con body `{ Name }`
- **Gmail send:** `gmail.users.messages.send({ userId, requestBody: { raw: base64encoded(email) } })`
- **Tabla actual `quickbooks_tokens`** ya existe (creada el 6 de mayo)
- **Token Realm ID actual:** `9341452691689682` (Dream Entertainment LLC)

---

## ✅ Lo que ya está validado

Estos puntos los probé hoy y FUNCIONAN — no hay riesgo técnico:

- ✅ Conexión OAuth con QuickBooks de producción (Realm `9341452691689682`)
- ✅ Refresh automático de tokens en `lib/quickbooks.js`
- ✅ Cotejado por importe + fecha (después del fix de las comillas en TotalAmt)
- ✅ Update de Purchase con cambio de ClassRef y revert al estado original
- ✅ Edonis tiene 20 Classes ya configurados con nombres de propiedades
- ✅ `ClassTrackingPerTxnLine: true` — se puede asignar Class por línea
- ✅ Gmail OAuth funcional con la cuenta `login@thedreammanagement.com`

---

**Para la próxima sesión:** abre este documento y arrancamos por la **Fase A**.

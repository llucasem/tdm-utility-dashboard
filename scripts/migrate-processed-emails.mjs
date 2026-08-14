/**
 * Crea processed_emails: el registro de "este email ya lo he mirado".
 *
 * Por que hace falta: Gmail devuelve los mismos emails una y otra vez hasta
 * que consta que se procesaron. El sistema viejo lo resolvia metiendo el ruido
 * en utility_bills como filas de importe 0 — 1.709 de 2.380 filas (72%) eran
 * basura. La tabla de facturas pasa a tener SOLO facturas.
 *
 * Uso:  node scripts/migrate-processed-emails.mjs [--apply]
 */
import fs from 'fs';
import pg from 'pg';

const env = Object.fromEntries(
  fs.readFileSync(new URL('../.env.local', import.meta.url), 'utf8')
    .split(/\r?\n/).filter(l => l.includes('=') && !l.startsWith('#'))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim().replace(/^["']|["']$/g, '')]; })
);

const APPLY = process.argv.includes('--apply');
const pool  = new pg.Pool({ connectionString: env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
const q = async (s, p) => (await pool.query(s, p)).rows;

const yaExiste = await q(`select 1 from information_schema.tables where table_schema='public' and table_name='processed_emails'`);
const ruido    = await q(`select count(*)::int n from utility_bills where coalesce(amount_due,0)=0`);

console.log(`processed_emails ya existe : ${yaExiste.length ? 'si' : 'no'}`);
console.log(`filas de ruido en utility_bills: ${ruido[0].n}`);

if (!APPLY) { console.log('\n(dry-run: no se ha escrito nada. Usa --apply)'); await pool.end(); process.exit(0); }

await q(`
  create table if not exists processed_emails (
    gmail_message_id text primary key,
    provider         text,
    decision         text not null,        -- bill | credit | payment | noise | error
    template         text,
    account_last4    text,
    amount           numeric,
    email_subject    text,
    email_from       text,
    email_received_at timestamptz,
    bill_id          integer,              -- si genero factura
    note             text,
    processed_at     timestamptz not null default now()
  )`);
await q(`create index if not exists processed_emails_fecha on processed_emails (email_received_at desc)`);
await q(`create index if not exists processed_emails_decision on processed_emails (decision)`);
console.log('tabla processed_emails creada');

// Sembrar con lo ya visto para que el sync nuevo no re-procese 8 meses de emails.
const sembradas = await q(`
  insert into processed_emails
    (gmail_message_id, decision, account_last4, amount, email_subject, email_from, email_received_at, bill_id, note)
  select split_part(gmail_message_id,'#',1),
         case when coalesce(amount_due,0) > 0 then 'bill' else 'noise' end,
         account_last4, amount_due, email_subject, email_from, email_received_at,
         case when coalesce(amount_due,0) > 0 then id else null end,
         'sembrado desde utility_bills en la migracion'
    from utility_bills
   where gmail_message_id is not null
     and gmail_message_id not like 'qb:%'
  on conflict (gmail_message_id) do nothing
  returning 1`);
console.log(`sembradas ${sembradas.length} filas desde el historial de utility_bills`);

console.table(await q(`select decision, count(*)::int n from processed_emails group by 1 order by 2 desc`));
await pool.end();

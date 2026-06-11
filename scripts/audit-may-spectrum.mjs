/**
 * Investiga el desajuste mayo: 55 bills en DB vs 42 utilities en QB.
 * Cross-check bill ↔ Purchase contemplando abr/may/jun en QB.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const env = {};
for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*)$/);
  if (m) env[m[1].trim()] = m[2].trim();
}
const { Pool } = pg;
const pool = new Pool({ connectionString: env['DATABASE_URL'], ssl: { rejectUnauthorized: false } });

const t = await pool.query(`SELECT realm_id, access_token FROM quickbooks_tokens ORDER BY updated_at DESC LIMIT 1`);
const { realm_id, access_token } = t.rows[0];
const BASE = `https://quickbooks.api.intuit.com/v3/company/${realm_id}`;

async function qb(sql) {
  const r = await fetch(`${BASE}/query?query=${encodeURIComponent(sql)}&minorversion=70`, { headers: { Authorization: `Bearer ${access_token}`, Accept: 'application/json' }});
  if (!r.ok) throw new Error(`QB ${r.status}: ${await r.text()}`);
  return r.json();
}

const utilV = ['spectrum','con edis','conedison','sce','southern california edison','ladwp','dwp','socalgas','desert water','t-mobile','optimum','verizon','at&t','national grid'];
const isUtil = n => { if (!n) return false; const nl = n.toLowerCase(); return utilV.some(v => nl.includes(v)); };

// Bills May
const bills = await pool.query(`
  SELECT id, utility_type, amount_due, email_received_at, property_address, unit, account_last4, email_subject, email_from, qb_tag_status
  FROM utility_bills
  WHERE amount_due > 0
    AND email_received_at >= '2026-05-01' AND email_received_at < '2026-06-01'
  ORDER BY email_received_at
`);

// Purchases QB: April + May + June
const [pMay, pApr, pJun] = await Promise.all([
  qb(`SELECT * FROM Purchase WHERE TxnDate >= '2026-05-01' AND TxnDate <= '2026-05-31' MAXRESULTS 500`),
  qb(`SELECT * FROM Purchase WHERE TxnDate >= '2026-04-01' AND TxnDate <= '2026-04-30' MAXRESULTS 500`),
  qb(`SELECT * FROM Purchase WHERE TxnDate >= '2026-06-01' AND TxnDate <= '2026-06-30' MAXRESULTS 500`),
]);

const allUtils = [
  ...(pApr.QueryResponse?.Purchase || []),
  ...(pMay.QueryResponse?.Purchase || []),
  ...(pJun.QueryResponse?.Purchase || []),
].filter(p => isUtil(p.EntityRef?.name));

const utilsMay = (pMay.QueryResponse?.Purchase || []).filter(p => isUtil(p.EntityRef?.name));
console.log(`Bills mayo DB: ${bills.rowCount}`);
console.log(`Utility Purchases QB: abril=${(pApr.QueryResponse?.Purchase || []).filter(p => isUtil(p.EntityRef?.name)).length}  mayo=${utilsMay.length}  junio=${(pJun.QueryResponse?.Purchase || []).filter(p => isUtil(p.EntityRef?.name)).length}`);

// ─── Detección de duplicados ────────────────────────────────────────
console.log('\n═══ DUPLICADOS en DB (misma cuenta + mismo importe en mayo) ═══');
const byKey = new Map();
for (const b of bills.rows) {
  const k = (b.account_last4 || '?') + '_' + Number(b.amount_due).toFixed(2);
  if (!byKey.has(k)) byKey.set(k, []);
  byKey.get(k).push(b);
}
const dups = [...byKey.entries()].filter(([k, list]) => list.length > 1);
if (dups.length === 0) {
  console.log('  Ninguno');
} else {
  for (const [k, list] of dups) {
    console.log(`  Cuenta ····${k.split('_')[0]}  $${k.split('_')[1]}:`);
    for (const b of list) {
      console.log(`    Bill #${b.id}  ${b.utility_type}  recv=${b.email_received_at.toISOString().slice(0,10)}  "${(b.property_address || '(unassigned)').slice(0,35)}"  status=${b.qb_tag_status}  subj="${(b.email_subject || '').slice(0,40)}"`);
    }
  }
}

// ─── Cross-match cada bill vs QB ────────────────────────────────────
console.log('\n═══ Cross-match: cada bill vs Purchases QB (abr/may/jun) ═══');
const noMatchBills = [];
const matchWrongMonth = [];
let matchedInMay = 0;

for (const b of bills.rows) {
  const amt = Number(b.amount_due);
  const recv = b.email_received_at;
  const wFrom = new Date(recv); wFrom.setUTCDate(wFrom.getUTCDate() - 3);
  const wTo = new Date(recv); wTo.setUTCDate(wTo.getUTCDate() + 30);

  let expectedV = null;
  const ef = (b.email_from || '').toLowerCase();
  if (ef.includes('spectrum')) expectedV = ['spectrum'];
  else if (ef.includes('coned')) expectedV = ['con edis','conedison','con edison'];
  else if (ef.includes('sce')) expectedV = ['sce','southern california edison'];
  else if (ef.includes('socalgas')) expectedV = ['socalgas'];
  else if (ef.includes('ladwp')) expectedV = ['ladwp','dwp'];
  else if (ef.includes('att')) expectedV = ['at&t','att'];

  const candsAmt = allUtils.filter(p => Math.abs(Number(p.TotalAmt) - amt) < 0.01);
  const candsVendor = candsAmt.filter(p => {
    if (!expectedV) return true;
    const pn = (p.EntityRef?.name || '').toLowerCase();
    return expectedV.some(v => pn.includes(v));
  });
  const inWindow = candsVendor.filter(p => p.TxnDate >= wFrom.toISOString().slice(0,10) && p.TxnDate <= wTo.toISOString().slice(0,10));

  if (candsVendor.length === 0) {
    noMatchBills.push({ b, candsAmt });
  } else if (inWindow.length === 0) {
    matchWrongMonth.push({ b, candsVendor });
  } else {
    matchedInMay++;
  }
}

console.log(`\n  Bills con match dentro de ventana:  ${matchedInMay}`);
console.log(`  Bills con match FUERA de ventana:    ${matchWrongMonth.length}`);
console.log(`  Bills SIN match en QB (en 3 meses):  ${noMatchBills.length}`);

if (matchWrongMonth.length > 0) {
  console.log('\n─── FUERA de ventana (probablemente facturas duplicadas o de otro mes) ───');
  for (const { b, candsVendor } of matchWrongMonth) {
    console.log(`  Bill #${b.id}  ${b.utility_type} $${b.amount_due}  recv=${b.email_received_at.toISOString().slice(0,10)}  ····${b.account_last4}  "${(b.property_address || '?').slice(0,30)}"`);
    for (const c of candsVendor) {
      console.log(`     → Purchase ${c.Id}  ${c.TxnDate}  ${c.EntityRef?.name}`);
    }
  }
}
if (noMatchBills.length > 0) {
  console.log('\n─── SIN match en QB en NINGÚN mes (abr/may/jun) ───');
  for (const { b, candsAmt } of noMatchBills) {
    console.log(`  Bill #${b.id}  ${b.utility_type} $${b.amount_due}  recv=${b.email_received_at.toISOString().slice(0,10)}  ····${b.account_last4}  ${(b.email_from || '').slice(0,30)}`);
    if (candsAmt.length > 0) {
      console.log(`     (hay ${candsAmt.length} Purchases con mismo amount pero distinto vendor)`);
    }
  }
}

await pool.end();

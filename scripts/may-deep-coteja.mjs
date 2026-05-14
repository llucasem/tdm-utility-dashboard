/**
 * Vendor + amount + date deep coteja for May 2026 bills.
 * Compares each utility_bill in May against ALL QB transactions of the same
 * vendor regardless of month — to find any reasonable connection.
 */

import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { readFileSync } from 'fs';
import pg from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
for (const line of readFileSync(join(__dirname, '..', '.env.local'), 'utf8').split('\n')) {
  const m = line.match(/^([^#=]+)=(.*?)(?:\s*#.*)?$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
}

const { Pool } = pg;
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function getTok() {
  const r = await pool.query(`SELECT realm_id, access_token, refresh_token, expires_at FROM quickbooks_tokens ORDER BY updated_at DESC LIMIT 1`);
  const row = r.rows[0];
  if (new Date(row.expires_at).getTime() - Date.now() > 5 * 60_000) return row;
  const basic = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const res = await fetch('https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded', Authorization: `Basic ${basic}` },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: row.refresh_token }),
  });
  const t = await res.json();
  await pool.query(`UPDATE quickbooks_tokens SET access_token=$1, refresh_token=$2, expires_at=$3, updated_at=NOW() WHERE realm_id=$4`,
    [t.access_token, t.refresh_token, new Date(Date.now() + t.expires_in * 1000), row.realm_id]);
  return { ...row, access_token: t.access_token };
}
const tok = await getTok();

async function qb(sql) {
  const url = `https://quickbooks.api.intuit.com/v3/company/${tok.realm_id}/query?query=${encodeURIComponent(sql)}&minorversion=70`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${tok.access_token}`, Accept: 'application/json' } });
  if (!r.ok) return { __err: r.status };
  return r.json();
}

// Pull ALL relevant transactions for April + May (so we can detect cross-month payments)
console.log('Pulling QB transactions 2026-04-01 → 2026-05-31 ...');
const allTx = [];
for (const entity of ['Purchase', 'Bill', 'BillPayment']) {
  let pos = 1;
  while (true) {
    const q = await qb(`SELECT * FROM ${entity} WHERE TxnDate >= '2026-04-01' AND TxnDate <= '2026-05-31' STARTPOSITION ${pos} MAXRESULTS 500`);
    const items = q?.QueryResponse?.[entity] || [];
    for (const t of items) allTx.push({ entity, t });
    if (items.length < 500) break;
    pos += 500;
  }
}
console.log(`  ${allTx.length} transactions total`);

const utilityRegex = /Spectrum|Con\s*Edis|SoCalGas|SCE|Southern California Edison|LADWP|Edison|Amazon|AT&T|Verizon|Optimum|National Grid|NYSEG|Eversource|DWP/i;
const utilTx = allTx.filter(x => utilityRegex.test((x.t.EntityRef?.name || x.t.VendorRef?.name || '') + ' ' + (x.t.PrivateNote || '')));
console.log(`  ${utilTx.length} are utility-vendor\n`);

// Pull our May bills
const billsR = await pool.query(`
  SELECT id, utility_type, property_address, unit, amount_due, due_date::date AS due_date,
         email_received_at::date AS email_date, email_from
  FROM utility_bills
  WHERE email_received_at >= '2026-05-01' AND email_received_at < '2026-06-01' AND amount_due > 0
  ORDER BY id
`);

function inferProvider(bill) {
  const f = (bill.email_from || '').toLowerCase();
  if (f.includes('coned'))      return 'ConEdison';
  if (f.includes('spectrum'))   return 'Spectrum';
  if (f.includes('socalgas'))   return 'SoCalGas';
  if (f.includes('sce.') || f.includes('southern california edison')) return 'Southern California Edison';
  if (f.includes('ladwp') || f.includes('dwp')) return 'LADWP';
  if (f.includes('amazon'))     return 'Amazon';
  if (f.includes('att.') || f.includes('at&t')) return 'AT&T';
  return null;
}

function vendorMatches(provider, qbName) {
  if (!qbName || !provider) return false;
  const p = provider.toLowerCase();
  const q = qbName.toLowerCase();
  if (p === 'conedison' && (q.includes('con edis') || q.includes('conedison'))) return true;
  if (p === 'spectrum'  && q.includes('spectrum'))   return true;
  if (p === 'socalgas'  && q.includes('socalgas'))   return true;
  if (p.includes('southern california') && (q.includes('southern california edison') || q.includes('sce'))) return true;
  if (p === 'ladwp'     && (q.includes('dwp') || q.includes('ladwp'))) return true;
  if (p === 'amazon'    && q.includes('amazon'))     return true;
  if (p === 'at&t'      && q.includes('at&t'))       return true;
  return false;
}

console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
console.log('   ANÁLISIS DETALLADO POR FACTURA DE MAYO');
console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

let exactMay = 0, exactApril = 0, sameVendorClose = 0, sameVendorAny = 0, noVendor = 0;
const matchExamples = { exactMay: [], exactApril: [], sameVendorClose: [] };

for (const b of billsR.rows) {
  const provider = inferProvider(b);
  if (!provider) { noVendor++; continue; }

  const sameVendor = utilTx.filter(x => vendorMatches(provider, x.t.EntityRef?.name || x.t.VendorRef?.name));
  const exactAmt = sameVendor.filter(x => Number(x.t.TotalAmt).toFixed(2) === Number(b.amount_due).toFixed(2));
  const closeAmt = sameVendor.filter(x => {
    const diff = Math.abs(Number(x.t.TotalAmt) - Number(b.amount_due));
    return diff > 0 && diff < 1.00;
  });

  if (exactAmt.length > 0) {
    const inMay   = exactAmt.filter(x => x.t.TxnDate >= '2026-05-01');
    const inApril = exactAmt.filter(x => x.t.TxnDate < '2026-05-01');
    if (inMay.length > 0)   { exactMay++;   matchExamples.exactMay.push({ b, qb: inMay[0] }); }
    else                     { exactApril++; matchExamples.exactApril.push({ b, qb: inApril[0] }); }
  } else if (closeAmt.length > 0) {
    sameVendorClose++; matchExamples.sameVendorClose.push({ b, qb: closeAmt[0] });
  } else if (sameVendor.length > 0) {
    sameVendorAny++;
  } else {
    noVendor++;
  }
}

console.log(`\n  ✓ Exacto en mayo:             ${exactMay}`);
console.log(`  ✓ Exacto pero pagada en abril: ${exactApril}`);
console.log(`  ~ Mismo proveedor, ±$1:        ${sameVendorClose}`);
console.log(`  ~ Mismo proveedor, importe distinto: ${sameVendorAny}`);
console.log(`  ✗ Proveedor sin txns en QB:    ${noVendor}`);

if (matchExamples.exactMay.length > 0) {
  console.log(`\n— Exactos en mayo (${matchExamples.exactMay.length}) —`);
  for (const m of matchExamples.exactMay) {
    console.log(`  bill #${m.b.id} $${m.b.amount_due} ${m.b.utility_type} email ${m.b.email_date.toISOString().slice(0,10)}`);
    console.log(`    → ${m.qb.entity} ${m.qb.t.Id} pagada ${m.qb.t.TxnDate} a ${m.qb.t.EntityRef?.name || m.qb.t.VendorRef?.name}`);
  }
}

if (matchExamples.exactApril.length > 0) {
  console.log(`\n— Exactos en abril (cross-month) (${matchExamples.exactApril.length}) —`);
  for (const m of matchExamples.exactApril) {
    console.log(`  bill #${m.b.id} $${m.b.amount_due} ${m.b.utility_type} email ${m.b.email_date.toISOString().slice(0,10)}`);
    console.log(`    → ${m.qb.entity} ${m.qb.t.Id} pagada ${m.qb.t.TxnDate} a ${m.qb.t.EntityRef?.name || m.qb.t.VendorRef?.name}`);
  }
}

if (matchExamples.sameVendorClose.length > 0) {
  console.log(`\n— Mismo proveedor, importe cercano ±$1 (${matchExamples.sameVendorClose.length}) —`);
  for (const m of matchExamples.sameVendorClose) {
    console.log(`  bill #${m.b.id} $${m.b.amount_due} ${m.b.utility_type}`);
    console.log(`    ≈ ${m.qb.entity} ${m.qb.t.Id} $${Number(m.qb.t.TotalAmt).toFixed(2)} ${m.qb.t.TxnDate} (diff $${Math.abs(Number(m.qb.t.TotalAmt) - Number(m.b.amount_due)).toFixed(2)})`);
  }
}

await pool.end();

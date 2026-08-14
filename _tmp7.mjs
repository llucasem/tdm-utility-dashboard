import fs from 'fs'; import pg from 'pg';
const env=Object.fromEntries(fs.readFileSync('.env.local','utf8').split(/\r?\n/).filter(l=>l.includes('=')&&!l.startsWith('#')).map(l=>{const i=l.indexOf('=');return[l.slice(0,i).trim(),l.slice(i+1).trim().replace(/^["']|["']$/g,'')];}));
const pool=new pg.Pool({connectionString:env.DATABASE_URL,ssl:{rejectUnauthorized:false}});
const q=async(s,p)=>(await pool.query(s,p)).rows;
console.log('=== Emails de SoCalGas que produjeron MAS DE UNA factura ===');
const r=await q(`select split_part(gmail_message_id,'#',1) msg, to_char(min(email_received_at),'YYYY-MM-DD') f,
   count(*)::int n, string_agg(account_last4||' -> '||coalesce(split_part(property_address,',',1),'?')||' #'||coalesce(unit,'-')||' $'||amount_due, E'\n        ' order by account_last4) detalle
 from utility_bills
 where amount_due>0 and not coalesce(is_duplicate,false)
   and (email_from ilike '%socalgas%' or utility_type='gas')
 group by 1 having count(*)>1 order by min(email_received_at)`);
for(const x of r) console.log(`\n  ${x.f}  msg ${x.msg.slice(0,22)}  ->  ${x.n} facturas\n        ${x.detalle}`);
console.log(`\nTotal de emails de gas que generaron varias facturas: ${r.length}`);
await pool.end();

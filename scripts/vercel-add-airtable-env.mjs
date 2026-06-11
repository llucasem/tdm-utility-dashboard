/**
 * Add AIRTABLE_PAT (and the rent base/table IDs) to Vercel project env vars
 * then trigger a redeploy. Uses VERCEL_TOKEN + AIRTABLE_PAT from .env.local
 * — token is never echoed.
 *
 * Idempotent: if the env var already exists, we PATCH instead of POST.
 */

const PROJECT = process.argv[2] || 'tdm-utility-dashboard';
const TOKEN   = process.env.VERCEL_TOKEN;
const PAT     = process.env.AIRTABLE_PAT;

if (!TOKEN || !PAT) {
  console.error('VERCEL_TOKEN and AIRTABLE_PAT must be set in .env.local');
  process.exit(1);
}

const HEADERS = {
  Authorization: `Bearer ${TOKEN}`,
  'Content-Type': 'application/json',
};

async function vercel(path, init = {}) {
  const r = await fetch(`https://api.vercel.com${path}`, {
    ...init,
    headers: { ...HEADERS, ...(init.headers || {}) },
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Vercel ${r.status} on ${path}: ${JSON.stringify(body).slice(0, 400)}`);
  return body;
}

// 1) confirm project access
console.log(`\n── Checking project access ──`);
const proj = await vercel(`/v9/projects/${PROJECT}`);
console.log(`  ✓ project: ${proj.name} (id ${proj.id})`);
console.log(`  ✓ linked:  ${proj.link?.type || '?'}/${proj.link?.org || ''}/${proj.link?.repo || ''}`);

// 2) read existing env vars to detect collisions
const envList = await vercel(`/v9/projects/${PROJECT}/env`);
const existing = new Map();
for (const e of envList.envs || []) existing.set(e.key, e);

// 3) write/update each var
const vars = [
  { key: 'AIRTABLE_PAT',                 value: PAT, type: 'encrypted' },
  { key: 'AIRTABLE_RENT_BASE_ID',        value: 'app4hMyYd61s95xqV', type: 'plain' },
  { key: 'AIRTABLE_EMAILS_TABLE_ID',     value: 'tblcWkXqmdR8JI6Pq', type: 'plain' },
  { key: 'NEXT_PUBLIC_AIRTABLE_BASE_ID', value: 'app4hMyYd61s95xqV', type: 'plain' },
  { key: 'NEXT_PUBLIC_AIRTABLE_TABLE_ID',value: 'tblcWkXqmdR8JI6Pq', type: 'plain' },
];

console.log(`\n── Adding/updating ${vars.length} env vars ──`);
for (const v of vars) {
  const existed = existing.get(v.key);
  if (existed) {
    await vercel(`/v9/projects/${PROJECT}/env/${existed.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        value:  v.value,
        type:   v.type,
        target: ['production', 'preview', 'development'],
      }),
    });
    console.log(`  ↻ ${v.key} updated`);
  } else {
    await vercel(`/v10/projects/${PROJECT}/env`, {
      method: 'POST',
      body: JSON.stringify({
        key:    v.key,
        value:  v.value,
        type:   v.type,
        target: ['production', 'preview', 'development'],
      }),
    });
    console.log(`  + ${v.key} created`);
  }
}

// 4) find the most recent production deployment and trigger a redeploy
console.log(`\n── Triggering redeploy ──`);
const deploys = await vercel(`/v6/deployments?projectId=${proj.id}&limit=1&target=production`);
const last = deploys.deployments?.[0];
if (!last) throw new Error('No previous production deployment found');
console.log(`  last prod deploy: ${last.uid}  (${last.url})`);

// Create a new deployment from the same git source — this picks up the new env vars
const newDeploy = await vercel(`/v13/deployments`, {
  method: 'POST',
  body: JSON.stringify({
    name: proj.name,
    target: 'production',
    gitSource: {
      type: 'github',
      ref:  'master',
      repoId: last.meta?.githubRepoId || undefined,
    },
  }),
});
console.log(`  ✓ new deploy queued: ${newDeploy.id || newDeploy.uid}`);
console.log(`     url: https://${newDeploy.url}`);
console.log(`\nDone. Watch progress at: https://vercel.com/${proj.link?.org || 'llucasem'}/${proj.name}`);

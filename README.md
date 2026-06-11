# TDM Utilities Dashboard

Internal utility bill management dashboard for **The Dream Management LLC** — a short-term rental company managing ~67 properties across New York, Los Angeles, Palm Springs, and Oslo.

## What it does

Replaces the manual process of logging into 50+ utility accounts one by one. The system automatically reads emails from the Gmail "Utilities" folder, extracts bill data using AI, and presents everything in a clean dashboard organized by service type and month.

- **Tabs** by utility type: Electricity, Internet, Gas, Rent, Insurance, Other
- **Monthly view** — all stats, counts, and tables filtered by selected month
- **Account mapping** — map utility account numbers to properties once; all current and future bills update automatically
- **Sync** — manual sync button + GitHub Actions every 2h (`.github/workflows/sync.yml`, auth via `CRON_SECRET`) + daily Vercel cron as fallback. Each run fetches up to 50 new emails (90-day rolling window) and parses up to 10 with Claude; noise is persisted as 0-amount rows so it never re-consumes quota. A staleness alarm fires if sync hasn't run in >12h.
- **LADWP** — payment confirmations (the only email LADWP sends) are ingested as bills with status `paid`
- **QuickBooks export** — CSV export compatible with QuickBooks
- **Bill detail** — direct link to original Gmail email for each bill

## Stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 15, React 19 |
| Database | Neon (PostgreSQL) |
| Email source | Gmail API (OAuth 2.0) |
| AI parser | Claude Sonnet (`claude-sonnet-4-6`) |
| Accounting | QuickBooks Online API (Intuit) |
| Deployment | Vercel |

## Project structure

```
app/
  page.js                        # Main dashboard
  admin/page.js                  # Account mapping admin screen
  api/
    bills/route.js               # GET — serve bills from database
    sync/route.js                # GET — sync new emails from Gmail
    account-mappings/route.js    # GET/POST — manage account mappings
    account-mappings/unmapped/   # GET — accounts without a property assigned
components/                      # UI components (TopBar, TabNav, BillsTable, etc.)
lib/
  gmail.js                       # Gmail OAuth2 connection
  parser.js                      # Claude AI email parser
  db.js                          # Neon PostgreSQL connection
scripts/
  get-gmail-token.js             # One-time OAuth setup script
  run-sync.mjs                   # Full historical sync (no timeout)
  reprocess-addresses.mjs        # Reprocess bills missing property address
```

## Environment variables

Create a `.env.local` file at the root with the following variables:

```
DATABASE_URL=

# Gmail OAuth
GMAIL_CLIENT_ID=
GMAIL_CLIENT_SECRET=
GMAIL_REFRESH_TOKEN=        # Generate with: node scripts/get-gmail-token.js
GMAIL_USER=

# Claude AI
ANTHROPIC_API_KEY=

# QuickBooks Online (Intuit Developer — app "Edonis Utility Dashboard")
QB_CLIENT_ID=               # From developer.intuit.com → Keys & credentials
QB_CLIENT_SECRET=
QB_REFRESH_TOKEN=           # Generate with: node scripts/get-qb-token.js
QB_REALM_ID=                # QB company ID (visible in QBO URL when logged in)
QB_ENVIRONMENT=sandbox      # "sandbox" or "production"
```

## QuickBooks Online — integration status

**Sandbox connected:** 22/04/2026 ✅

| Variable | Status |
|---|---|
| `QB_CLIENT_ID` | ✅ Set |
| `QB_CLIENT_SECRET` | ✅ Set |
| `QB_REFRESH_TOKEN` | ✅ Set (sandbox) |
| `QB_REALM_ID` | ✅ Set (sandbox company) |
| `QB_ENVIRONMENT` | `sandbox` → change to `production` after Intuit approval |

**How the OAuth was obtained:**
1. Created app `Edonis Utility Dashboard` at developer.intuit.com (Accounting scope only)
2. Added `http://localhost` as Redirect URI in Development Settings
3. Ran `node scripts/get-qb-token.js` → generated auth URL
4. Authorized using Intuit's sandbox test company (no real QB account needed for sandbox)
5. Pasted redirect URL → script exchanged code for `refresh_token` + `realmId`
6. Verified: connected successfully, reads Bills from sandbox ✅

**To move to production:**
1. Go to developer.intuit.com → Production Settings → add Redirect URI
2. Complete Intuit's compliance form (Privacy Policy + EULA required)
3. Pass Intuit security assessment → **1–3 weeks approval time**
4. Swap all `QB_*` variables for production values and set `QB_ENVIRONMENT=production`
5. Re-run `node scripts/get-qb-token.js` with Edonis's real QB account (needs admin access)

**What we can do with the current scope (`com.intuit.quickbooks.accounting`):**
- Read Bills, BillPayments, Vendors, Accounts, Purchases
- Update Bills (add memos, internal references)
- Create BillPayments (mark bills as paid — requires specifying payment method + bank account)
- Run financial reports

**What is NOT included (by design):**
- Payment processing (`com.intuit.quickbooks.payment` scope — not requested)

**Next steps in the app:**
- [ ] `lib/qb.js` — QuickBooks client (OAuth token refresh + API calls)
- [ ] `app/api/qb/bills/route.js` — read QB Bills and serve to dashboard
- [ ] Match utility bills from Gmail ↔ Bills in QuickBooks by amount + date + vendor
- [ ] Show QuickBooks status in BillDetailModal

---

## Running locally

```bash
npm install
npm run dev
```

Open [http://localhost:3000](http://localhost:3000).

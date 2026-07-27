# Niobe Beauty — Multi-Branch SimpleSpa Integration

A unified layer over the **SimpleSpa Enterprise API** that brings Niobe Beauty's five
branches (East Legon, Cantonments, African Regent Hotel, HFC Community 18, Alisa Hotel Tema)
into one seamless experience.

## Modules

1. **Cross-branch product stock** *(this milestone)* — one consolidated view of live inventory
   across every branch, for both customers and branch staff. Search, category filter, and
   per-branch low/out-of-stock flags.
2. **Unified booking availability** *(next)* — merged services / therapists / slots across all
   branches, filterable by service, therapist or date.
3. **Deposit payments + auto-confirm** *(next)* — Paystack pay-link (cards, mobile money, bank
   transfer) for part/full upfront payment; on funds cleared the booking is auto-confirmed in
   SimpleSpa via the Appointment-Status write endpoint, stamped with the unique payment reference.

## How the stock module works

Each branch has its own SimpleSpa API credential (`KEY:SECRET`). The service fans out to every
branch's `POST /api/v1/products.php` in parallel, merges the results by SKU (falling back to
product name), and returns a single catalogue with per-branch quantities and a combined total.
A failing branch is reported in the response but never blocks the others.

## Requirements

- Node.js 18+ (no external dependencies — uses only the Node standard library)

## Setup

```bash
cp .env.example .env      # then fill in each branch's KEY and SECRET
npm start                 # or: node src/server.js
```

Open http://localhost:3000

### Configuration (`.env`)

| Variable | Purpose |
| --- | --- |
| `DEMO_MODE` | `true` serves sample data in the real API format (for preview). Set `false` to pull live branch data. |
| `<BRANCH>_KEY` / `<BRANCH>_SECRET` | Each branch's SimpleSpa API credential. |
| `LOW_STOCK_THRESHOLD` | Quantity at or below which a branch is flagged "low". |
| `SIMPLESPA_BASE` | API base URL (default `https://my.simplespa.com/api/v1`). |

## API

| Endpoint | Description |
| --- | --- |
| `GET /api/stock` | Consolidated cross-branch catalogue (JSON). |
| `GET /api/health` | Health check. |

## Notes

- SimpleSpa API keys must be **Read** enabled for stock, and **Read + Write (Mode 3)** for the
  upcoming payment auto-confirm step.
- Credentials are read from `.env` only and are never committed (`.env` is git-ignored).

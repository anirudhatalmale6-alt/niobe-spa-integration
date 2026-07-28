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
3. **Deposit payments + auto-confirm** *(built — test mode)* — a hosted pay-link (cards, mobile
   money, bank transfer) for a minimum 50% deposit or full payment; on funds cleared the booking
   is auto-confirmed in SimpleSpa via the Appointment-Status write endpoint (status 20), stamped
   with the unique payment reference. Bookings covered by a gift card / account credit skip the
   deposit. The gateway sits behind a thin adapter layer (`src/gateway.js`) — **Hubtel** (recommended
   primary for Ghana: mobile money + cards), **expressPay** and **Paystack** are all supported.
   `PAYMENT_GATEWAY` sets the primary and `PAYMENT_GATEWAY_BACKUP` sets a backup that is both
   offered to the customer ("pay with expressPay instead") and used for **automatic failover** if
   the primary is unreachable at checkout. Transaction fees are borne by the customer
   (`CUSTOMER_PAYS_FEES` — the Ghana norm; set fee-bearer = customer at the gateway account level).
   `PAYMENT_DEMO=true` runs the whole flow against a local simulator so it can be proven before
   live keys exist.

### Deposit flow endpoints

| Route | Description |
| --- | --- |
| `GET /pay?booking=<id>` | Customer-facing deposit page (choose 50% or full). |
| `POST /pay/start` | Creates the Paystack transaction and redirects to the pay link. |
| `GET /pay/callback` | Verifies payment, auto-confirms the SimpleSpa appointment, shows result. |
| `POST /webhook/payment` | Live gateway webhook — auto-confirms on a successful payment (re-verified via the gateway's status API). `/webhook/paystack` is kept as an alias. |
| `GET /demo/checkout`, `POST /demo/pay` | Simulated Paystack checkout (demo mode only). |

## How the stock module works

Each branch has its own SimpleSpa API key (`Authorization: Bearer <KEY>`; read/write is set by the
key's Mode in the dashboard — there is no separate secret). The service fans out to every
branch's `POST /api/v1/products.php` in parallel, merges the results by SKU (falling back to
product name), and returns a single catalogue with per-branch quantities and a combined total.
A failing branch is reported in the response but never blocks the others.

## Requirements

- Node.js 18+ (no external dependencies — uses only the Node standard library)

## Setup

```bash
cp .env.example .env      # then fill in each branch's API KEY (Mode 3)
npm start                 # or: node src/server.js
```

Open http://localhost:3000

### Configuration (`.env`)

| Variable | Purpose |
| --- | --- |
| `DEMO_MODE` | `true` serves sample data in the real API format (for preview). Set `false` to pull live branch data. |
| `<BRANCH>_KEY` | Each branch's SimpleSpa API key (Mode 3 for auto-confirm + inventory writes). |
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

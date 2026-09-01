# The public gift-card balance page

`GET /balance` · `POST /balance` (aliases: `/gift-card/balance`)

Lets a customer check what is left on a gift card without telephoning a branch.
Not getting through to a branch by phone is the complaint that runs through this
whole project, so this small page removes a real call.

## What it searches

All three ledgers, via the existing `lookupAnyCard()` in `src/cards.js`:

1. **Niobe's own** — every card sold on the new system. In-process, cannot fail.
2. **GiftUp** — everything sold up to the switch-over.
3. **SimpleSpa** — the older per-branch cards, ~1,700 of which still carry a balance.

The site as it stands checks only its own (empty) database, so a real GiftUp card
and a real SimpleSpa card both come back *"Invalid voucher code"*. That sentence
tells a customer holding genuine value that their gift is worthless, and they go
away. Searching all three is the entire point of the page.

## The distinction that must never be collapsed

| Situation | Status | What the customer is told |
|---|---|---|
| Every ledger answered; none had the code | **404** | Check the code and try again |
| A ledger did not answer | **503** + `Retry-After` | This is our side, not your card — try again shortly |

These two look nearly identical in the code and mean opposite things to someone
holding a real gift. The 503 is also logged, because otherwise an upstream outage
is invisible: the customer is told to try again and simply goes away.

`renderBalanceProblem()` gives them different headings, different advice and
different buttons. If you ever find yourself simplifying those into one "invalid
code" message, that is the bug this feature was written to avoid.

## Why this page carries protections the others do not

Every other page in this service is reached with a booking id or a payment
reference the customer was given. This is the only one an anonymous stranger can
drive with input of their own choosing.

- **Rate limited** (`src/ratelimit.js`): 6/min and 40/hour per address, plus a
  global 120/min backstop for the distributed case. All overridable by env
  (`BALANCE_RATE_PER_MIN`, `BALANCE_RATE_PER_HOUR`, `BALANCE_RATE_GLOBAL_PER_MIN`).

  Our own codes are `NB-XXXX-XXXX-XXXX` from a 31-character alphabet and are not
  guessable. The legacy SimpleSpa codes are short and dashed — `DPB-QO0` is a real
  one — and those are. **The weakest ledger sets the security of a page that
  searches all three.**

- **`clientIp()` reads X-Forwarded-For from the RIGHT.** nginx sets it with
  `$proxy_add_x_forwarded_for`, which *appends* the real peer to whatever the
  caller sent, so only the last entry is trustworthy. Reading the first — which is
  how most snippets do it — lets a caller set a different fake address on every
  request and bypass the limiter completely.

- **Codes are shape-checked before any upstream call.** Without that, the endpoint
  is a way for anyone to bounce arbitrary traffic off this page into SimpleSpa's
  API — the system the branches need working at 9am.

- **The mis-read retry is capped lower here** (`variantCap: 2`, versus 8 for staff
  and booking flows). One lookup already fans out to GiftUp plus five branches;
  multiplied by eight speculative re-readings, a single public request becomes
  fifty upstream calls.

- **Only the last four characters of a code are ever rendered.** A gift-card code
  is a bearer instrument: whoever reads it can spend it.

- **Everything reflected from user input goes through `esc()`.** Every other view
  in `views.js` interpolates values this service produced; here a stranger picks
  them.

- **An unpaid (reserved) card is byte-identical to a code that never existed.**
  Otherwise the page is an oracle for finding issued-but-unpaid codes, which are
  exactly the ones with no owner watching them.

## Configuration

| Env | Default | Notes |
|---|---|---|
| `BOOKING_URL` | *(empty)* | "Book an appointment" button is **hidden** when unset. Sending someone who has just seen a healthy balance to a page that cannot take a booking is worse than offering no link. |
| `BALANCE_RATE_PER_MIN` | 6 | Per address |
| `BALANCE_RATE_PER_HOUR` | 40 | Per address |
| `BALANCE_RATE_GLOBAL_PER_MIN` | 120 | Whole endpoint |
| `GIFTUP_BASE` | `https://api.giftup.app` | Overridable so the tests can stub it |

## Tests

`node scripts/test-balance.mjs` — 26 tests, against the real server over real HTTP
with both upstream ledgers replaced by a local stub that can be told to fail on
demand. Almost everything worth testing here is about what happens when something
goes wrong.

**These were verified against a deliberately sabotaged build** — escaper replaced
by the identity function, 404/503 collapsed, unpaid cards made discoverable. 8 of
26 failed. Two that should have failed did not, and both were rewritten:

- The XSS test asserted the lower-case payload was absent, but `normaliseCode`
  upper-cases its input, so it was measuring the upper-casing rather than the
  escaping — and `<SCRIPT>` executes perfectly well.
- The unpaid-card test asserted the code was absent from the page, which the retry
  box legitimately echoes back. The property that actually matters is that the
  response is *indistinguishable* from a non-existent code, so that is what it
  asserts now.

If you change this page, re-run that control. A test suite that cannot fail is
worse than none, because it is quoted as evidence.

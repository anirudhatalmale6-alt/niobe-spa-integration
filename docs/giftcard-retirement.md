# Retiring the legacy niobespagiftcard.com system

What was on the Hostinger plan, what was done to it on 29 August 2026, and what a
future maintainer needs to know. No passwords appear here; they are held separately.

## Why there were two systems

Niobe's main website is `niobebeauty.com`, on Wix. Separately, a departed developer
built a complete PHP gift-card application on a Hostinger Premium plan under
`niobespagiftcard.com`, with its own MySQL database, admin panel, cron jobs and
mailer. It was still live and still running when this work started, months after
anyone had touched it.

That is the thing to understand before reading further: **nobody was using it, and
it was still running.** Those are independent facts. Unused describes the traffic;
it says nothing about what the server was still executing on a schedule, or what
its endpoints would still answer.

## What was actually in it

Backed up and read before anything was changed:

| table | rows | what it held |
|---|---|---|
| `gift_card_orders` | 6 | all test orders — two gmail addresses, one buyer named "ygdes diajhks" |
| `gift_vouchers` | 1 | GHS 580, bought 22 Apr, expired 21 Jul, never redeemed |
| `voucher_redemptions` | 0 | nothing was ever redeemed, in the system's whole life |
| `gift_cards` | 22 | card artwork (the images are in `backoffice/uploads/`) |
| `employees` | 4 | admin logins, three of them generic `*@gmail.com` seeds |
| `configurations` | 6 | live Hubtel merchant account, API id and secret |
| `categories` / `service_categories` | 109 / 109 | treatment catalogue |
| `services` | 7 | services offered on the gift-card site |
| `manual_payment_methods` | 4 | Telecel and MTN MoMo numbers, a `*713*` shortcode, Zenith Bank |

No customer ever bought a gift card, and there was no outstanding balance to migrate.
That was confirmed from the database, not from anyone's recollection — the client
believed it was unused, and he was right, but "believed" is not a basis for deleting
a payment system.

Note the payment log disagreed with the table: `api/logs/gift_callback.log` recorded
19 successful payments between 22 March and 22 April, while `gift_card_orders` held
6 rows starting at id 67. Earlier rows had been deleted. **A log is a record of
events, not a count of what still exists** — if the two disagree, the table wins.

## The three problems found

### 1. The payment callback issued vouchers to anyone who asked

`api/callback.php` decided whether an order had been paid from the JSON posted to
it, and nothing else:

```php
$isPaid = ($responseCode === '0000') ||
          in_array($rootStatus, $successWords) ||
          in_array($dataStatus, $successWords);
```

No signature, no shared secret, no IP allow-list, no verification call back to the
gateway. `$amount` was parsed on line 74 and never compared to the order total.
`Access-Control-Allow-Origin: *`. References were `PAY<Ymd>-<4 digits>`, and the only
guard was that the order still be `pending`.

Anyone who posted a plausible reference was issued a funded gift voucher.

The general shape: **a webhook that trusts its caller is an open endpoint that mints
whatever it is in charge of minting.** A callback handler must verify a signature or
call the provider back, and must compare the amount paid against the amount owed.

### 2. Two cron jobs were still emailing customers, every minute

`cron/orders_cron.php` and `cron/vouchers_cron.php` between them sent payment
reminders, cancellation notices, expiry warnings and expired notices — and mutated
rows, cancelling orders and expiring vouchers.

They were live. The single voucher in the database proves it: `expiry_reminder_sent_at`
2026-07-07, `expired_at` 2026-07-21, four months after the site was last touched.

The client could not find them in hPanel because **Hostinger names cron jobs by random
id, not by the script they run.** They were found by the artefact each run leaves
behind, in `~/.logs/`:

```
cronjob_BzA1Ocg4yE  ->  vouchers_cron.php
cronjob_CDKG8evh2u  ->  orders_cron.php
```

Watching those two mtimes advance — 15:12:01, 15:13:01, 15:14:01 — established the
cadence: **once a minute**, about 1,440 runs a day each, since April. "I can't find it
in the control panel" is not evidence a job does not exist; look for what it writes.

### 3. One weak password, used twice, plus a named admin password

One nine-character password — weak, and of the `<symbol><digits><letters>` shape a
list would guess — was hardcoded as **both** the MySQL password (`db.php`) and the
SMTP password for `support@niobespagiftcard.com` (`_mail_boot.php`), a mailbox able to
send as Niobe. One string, two systems, one of which can email your customers.
And `backoffice/hash.php` was, in its entirety:

```php
<?php echo password_hash("admin123", PASSWORD_DEFAULT);
```

That names the password the admin account was seeded with, without anyone needing to
attempt a login. (The panel's own guards were sound — `includes/auth.php` and
`requireRole()` on every page. The credential was the weakness, not the code.)

## What was done

Everything below **adds** files. Nothing was renamed or deleted, so the whole change
reverses by removing what was added.

1. **Full backup first.** Files mirrored over FTP and verified by count against the
   server's own `find | wc -l` — 35,946 both sides. Database dumped over SSH,
   verified by counting `CREATE TABLE` statements (10), because `gzip -t` passes
   happily on an empty archive.

2. **A gate at the site root** — `deploy/giftcard-retire/.htaccess` plus a holding
   page. `api/`, `backoffice/` and `cron/` answer `410 Gone`; everything else lands on
   the holding page.

3. **A second gate inside `backoffice/`** — see the warning below.

4. **The cron scripts stubbed**, originals kept as `*.original`. An `.htaccess` closes
   the HTTP route to a folder; it does not touch the host's scheduler, which invokes
   the PHP file directly. The stub is what those jobs now execute, and the
   `~/.logs/cronjob_*` files confirm it in production: `RETIRED: ... did nothing`.

### The gate that did not cover what it looked like it covered

The root `.htaccess` made `niobespagiftcard.com/backoffice/login.php` return 410.
Verified, and it looked finished.

`backoffice.niobespagiftcard.com/login.php` was still answering **200**.

The subdomain is its own vhost whose document root *is* `public_html/backoffice`, so a
request to that hostname never traverses the parent directory and no parent `.htaccess`
is consulted. The rules there test a path that has already had `backoffice/` stripped
off it, so `^(api|backoffice|cron)` matches nothing. The admin login — the one whose
seed password is named in the code — stayed open on the hostname a person would
actually type.

**Probe every hostname that resolves to the box, not the one the rule was written
for.** A per-directory rule protects a directory, not a URL space; if the protection
matters, the file goes *in* the directory being protected. Belt and braces that
survives arriving by an unforeseen route:

```apache
<FilesMatch "\.(php|phtml|phar)$">
  Require all denied
</FilesMatch>
```

Both hostnames now return 410 for every executable path, checked from outside.

## Payment routing, and a correction

Hubtel account numbers on this estate:

| purpose | account | note |
|---|---|---|
| central | 2021493 | also where online gift-card sales settle |
| East Legon | 2021442 | |
| Cantonments | 2021439 | |
| African Regent | 2021440 | |
| HFC Community 18 | 2021441 | |
| Alisa Hotel Tema | 2021443 | |

The retired site used **2021493 — the same account as central**, but with its own API
key pair. An earlier note in this project claimed 1493 and 1442 were two different
accounts and that the build used 1442; that was wrong, and it was corrected only by
reading the live `.env` rather than trusting the note. 1442 is East Legon's branch
account. Gift-card money was already landing in 1493 without any change.

Because of that, the `GIFTCARD_HUBTEL_*` override was **removed** from the live
environment: it pointed at the same account as central but via the old site's exposed
key. `src/hubtel.js` still supports the split (`routeFor`, tested) — the variables are
simply unset, which is the documented "no separate account" case.

### The trap in `routeFor`, worth understanding before touching it

`initializeTransaction` knows the branch from metadata. `verifyTransaction` has **only
the reference** and recovers the route from the code the reference carries
(`NIOBE-<CODE>-<stamp>`). Both must resolve to the same account.

If they disagree, money is collected into one account and its status queried against
another. The gateway answers "payment record not found", the sale reads as unpaid, and
the customer is charged and never issued anything. It fails silently and surfaces as a
phone call.

Gift-card references use `GC` in the slot a branch code occupies, which is why
`GIFTCARD_REF_CODE` is exported from `hubtel.js` and used by `giftcards.js` to *build*
the reference — so the two spellings cannot drift.

Verified live across all six routes; each collects and queries the same account with
the same key.

**A caution about verifying this.** The first run of that check reported a mismatch on
East Legon. It was a bad test: the reference had been hand-written as `NIOBE-ELEG-…`,
but production derives the code with
`branchRefCode('east_legon')` → `east` → **`EAST`**. Generate test references with the
production helper and iterate the real `BRANCHES` list. A hand-typed fixture encodes
what you *believe* the format is, and when that belief is wrong it fails loudly and
plausibly.

## Gift-card pricing

Niobe's rules, confirmed 29 August 2026:

- 90 days validity
- 5% discount on orders of 2 or more cards, to be redeemed together
- 3% service charge, covering processing and site administration

Applied discount-first, service fee on the discounted subtotal — matching how the old
site itemised it. The total is the same either way (`0.95 × 1.03 == 1.03 × 0.95`); it
is the receipt lines the customer reads that differ.

**The discount reduces what the buyer pays, never what the cards are worth.** A
multi-buy checkout shows "Each card is worth GHS x" for exactly that reason: without
it, a discounted order reads as discounted cards, and that argument happens at
reception.

Quantity arrives from the browser and multiplies the amount charged, so it is clamped
rather than trusted: `999 → 10`, `-5 → 1`, `2.7 → 2`, `"abc" → 1`.

One live-configuration note that nearly went wrong: the code default was changed from
5% to 3%, but the running server's `.env` pinned `GIFTCARD_SURCHARGE_PCT=5`. The
deploy would have been entirely green while the price never moved. **After changing a
default, grep the live environment and read the number off the running page.**

## Where things are

- **Backup** — `backups/hostinger-2026-08-29-1032/` : `files/` (35,946 files, verified)
  and `u579484144_giftcard-2026-08-29.sql.gz` (10 tables). This is the only copy of the
  22 gift-card designs outside the server; they are in `files/backoffice/uploads/`.
- **Retirement gate** — `deploy/giftcard-retire/` : `.htaccess`, `backoffice.htaccess`,
  `holding.html`, and `apply.sh` (which verifies from outside after uploading, and
  has a `--revert`).
- **Credentials** — held outside this repository and never committed.

## Still outstanding

- **Delete the two hPanel cron entries.** They are stubbed, so they do nothing, but the
  server still executes them 2,880 times a day. Find them by the paths ending
  `cron/vouchers_cron.php` and `cron/orders_cron.php`.
- **Revoke the old site's Hubtel API key pair.** Nothing uses it any more, so this can
  be done at any time with no downtime. The central key was never exposed and does not
  need rotating.
- **Change the database and SMTP passwords.** Safe at any time now — the site is a
  holding page and nothing reads either.
- **Decide the old site's long-term fate.** It is offline, not deleted. Nothing should
  be deleted until the backup above has been stored somewhere the client controls.

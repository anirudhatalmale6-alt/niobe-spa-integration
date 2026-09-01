// A small sliding-window rate limiter, in memory, no dependencies.
//
// This exists for the public balance-check page. Every other page in this service is
// reached with a booking id or a payment reference that the customer was given; the
// balance page is the first one where an anonymous stranger can type a guess and be
// told whether it is worth money. That is a different kind of endpoint and it needs a
// different kind of protection:
//
//   1. ENUMERATION. Our own codes are NB-XXXX-XXXX-XXXX from a 31-character alphabet
//      (~7.9e17 combinations) and are not realistically guessable. But the legacy
//      SimpleSpa cards still in circulation are short and dashed — DPB-QO0 is a real
//      one — and those ARE guessable at a few hundred attempts a second. The weakest
//      ledger sets the security of a page that searches all three.
//   2. AMPLIFICATION. One lookup can fan out to GiftUp plus five SimpleSpa branches,
//      and the mis-read-character retry multiplies that again. Without a limit, one
//      script pointed at this page becomes a denial-of-service against Niobe's own
//      booking system — the thing the branches need working at 9am.
//
// Kept deliberately simple: no Redis, no dependency, no shared state. The service runs
// as a single process, so a Map is the whole design. If it is ever run multi-process
// the limit becomes per-process rather than global, which is worth knowing but is not
// a reason to add infrastructure now — the per-IP number is small enough that even a
// handful of workers stays far below what the upstream APIs will tolerate.
//
// Not a substitute for the checks in cards.js. A reserved (unpaid) card is still never
// reported as existing, and a code is still never echoed back in full. Rate limiting
// slows an attacker down; it is the other rules that decide what they learn.

// How many distinct keys to track before evicting. An attacker rotating IPs would
// otherwise grow this Map without bound, which turns a rate limiter into a memory leak
// — a slower outage, but an outage. On overflow the least-recently-seen keys go first,
// which is exactly the set least likely to be mid-attack.
const MAX_KEYS = Number(process.env.RATELIMIT_MAX_KEYS || 20000);

export function createLimiter(windows, { maxKeys = MAX_KEYS } = {}) {
  // windows: [{ ms, max, label }] — all must pass. A short window stops a burst, a long
  // one stops a patient grind. Checking both is what makes "6 a minute" mean something
  // other than "8,640 a day".
  const hits = new Map();          // key -> number[] (timestamps, ascending)
  const longest = Math.max(...windows.map((w) => w.ms));

  function prune(list, now) {
    // Timestamps are appended in order, so everything expired is at the front.
    let i = 0;
    while (i < list.length && now - list[i] >= longest) i++;
    return i ? list.slice(i) : list;
  }

  return {
    // Records an attempt and says whether it is allowed. Call once per attempt —
    // a limiter you check but do not record is not a limiter.
    check(key, now = Date.now()) {
      let list = prune(hits.get(key) || [], now);

      for (const w of windows) {
        const from = now - w.ms;
        // List is ascending, so count from the back and stop as soon as we leave
        // the window rather than scanning every retained timestamp.
        let n = 0;
        for (let i = list.length - 1; i >= 0 && list[i] > from; i--) n++;
        if (n >= w.max) {
          // Blocked attempts are NOT recorded. Otherwise hammering the endpoint keeps
          // pushing the release time back and a customer who genuinely mistyped three
          // times in a row is locked out for the rest of the hour.
          hits.set(key, list);
          const oldestInWindow = list[list.length - n];
          return {
            ok: false,
            window: w.label || `${Math.round(w.ms / 1000)}s`,
            max: w.max,
            retryAfterSec: Math.max(1, Math.ceil((oldestInWindow + w.ms - now) / 1000)),
          };
        }
      }

      list = [...list, now];
      hits.set(key, list);

      if (hits.size > maxKeys) {
        // Map iterates in insertion order, and re-setting a key does not move it, so
        // this is only approximately least-recently-used. Approximate is the right
        // amount of effort here: the cost of evicting an active key is that one
        // attacker gets a few extra attempts, not that anything breaks.
        const drop = Math.ceil(maxKeys * 0.1);
        let i = 0;
        for (const k of hits.keys()) { if (i++ >= drop) break; hits.delete(k); }
      }

      return { ok: true };
    },

    // Exposed for tests and for the health endpoint, not for logic.
    size() { return hits.size; },
    reset() { hits.clear(); },
  };
}

// The client's real address, given this service runs behind nginx.
//
// nginx sets X-Forwarded-For with $proxy_add_x_forwarded_for, which APPENDS the real
// peer address to whatever the client already sent. So the value is
//   <whatever the caller made up>, <whatever the caller made up>, <real peer>
// and only the LAST entry was written by our own proxy.
//
// Reading the first entry — which is the usual way this is written, and what most
// snippets do — hands the attacker the steering wheel: they set X-Forwarded-For to a
// random address on every request and the limiter counts each one separately, i.e. no
// limit at all. Taking the rightmost is the whole point.
export function clientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = String(xff).split(',').map((s) => s.trim()).filter(Boolean);
    if (parts.length) return parts[parts.length - 1];
  }
  return req.socket?.remoteAddress || 'unknown';
}

import { BRANCHES } from './config.js';
import { ssPost } from './simplespa.js';

// SimpleSpa's OWN gift cards — a second, older gift-card system running alongside
// GiftUp, discovered while answering Niobe's question about duplication.
//
// The two are entirely separate ledgers with different code formats (GiftUp issues
// 5-character codes like "XXP7P"; SimpleSpa issues dashed codes like "84L-PTW"), and
// a card from one is invisible to the other. Left alone, a customer holding one of
// the ~1,700 SimpleSpa cards that still carry a balance would be told "we couldn't
// find that gift card" — telling someone their genuinely valuable voucher is worthless.
//
// IMPORTANT LIMITATION: SimpleSpa's API can READ gift cards but exposes NO write
// endpoint for them (write/giftcard*.php all return "File not found" — only
// appointment-status and product can be written). So a SimpleSpa card can be
// verified but NOT deducted programmatically. That is a hard platform limit, not a
// choice, and it is why redemption of these cards ends in a staff task rather than
// an automatic deduction.
//
// Unlike services and products, gift cards are NOT shared across branches — each
// branch keeps its own list — so a lookup has to ask each branch until it hits.

// The endpoint supports an exact `code` filter, so a lookup is one small call per
// branch rather than paging thousands of rows.
export async function lookupSimpleSpaCard(code, branches = BRANCHES) {
  const c = String(code || '').trim();
  if (!c) return { found: false };

  const errors = [];
  for (const branch of branches) {
    let res;
    try {
      res = await ssPost(branch, 'giftcards.php', { code: c, per_page: 5 });
    } catch (e) {
      // One unreachable branch must not make a real card look non-existent.
      errors.push({ branch: branch.name, error: e.message });
      continue;
    }
    const hit = (res.gift_cards || []).find((g) => String(g.code || '').trim().toUpperCase() === c.toUpperCase());
    if (!hit) continue;

    const balance = Number(hit.balance || 0);
    return {
      found: true,
      branchId: branch.id,
      branchName: branch.name,
      giftcardId: hit.giftcard_id,
      code: hit.code,
      balance,
      initialBalance: Number(hit.initial_balance || 0),
      expired: !!hit.is_expired,
      expiresAt: hit.expires_at || null,
      templateName: hit.template_name || '',
      // Usable only if there is something left AND it hasn't lapsed.
      valid: balance > 0 && !hit.is_expired,
      errors,
    };
  }
  return { found: false, errors };
}

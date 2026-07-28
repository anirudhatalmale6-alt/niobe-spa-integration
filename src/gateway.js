// Gateway manager. The deposit / auto-confirm flow talks only to this module, so payment
// providers can be swapped or combined without touching bookings.js, server.js or the pages.
//
// - PAYMENT_GATEWAY chooses the primary provider (Hubtel for Ghana).
// - PAYMENT_GATEWAY_BACKUP is offered to the customer and used for automatic failover if
//   the primary is unreachable at checkout time.
import { CONFIG } from './config.js';
import * as paystack from './paystack.js';
import * as hubtel from './hubtel.js';
import * as expresspay from './expresspay.js';

const ADAPTERS = { paystack, hubtel, expresspay };

const primaryName = ADAPTERS[CONFIG.gateway] ? CONFIG.gateway : 'hubtel';
const backupName = ADAPTERS[CONFIG.gatewayBackup] && CONFIG.gatewayBackup !== primaryName
  ? CONFIG.gatewayBackup : null;

export const primary = primaryName;
export const backup = backupName;
export const displayName = ADAPTERS[primaryName].displayName;
export function displayNameOf(name) { return (ADAPTERS[name] || ADAPTERS[primaryName]).displayName; }
export function availableGateways() { return backupName ? [primaryName, backupName] : [primaryName]; }

// Initialise a payment. Tries the preferred gateway (or primary), then falls back to the
// backup if the first one throws (e.g. the provider is down). Returns which gateway was used.
export async function initializeTransaction(opts, preferred) {
  const order = [];
  const add = (n) => { if (n && ADAPTERS[n] && !order.includes(n)) order.push(n); };
  add(preferred);
  add(primaryName);
  add(backupName);

  let lastErr;
  for (const name of order) {
    try {
      const init = await ADAPTERS[name].initializeTransaction(opts);
      return { ...init, gateway: name };
    } catch (e) { lastErr = e; /* try the next gateway */ }
  }
  throw lastErr || new Error('No payment gateway available');
}

// Verify using the gateway that actually processed the payment.
export async function verifyTransaction(reference, gatewayName) {
  return (ADAPTERS[gatewayName] || ADAPTERS[primaryName]).verifyTransaction(reference);
}

export function verifyWebhookSignature(gatewayName, rawBody, signature) {
  return (ADAPTERS[gatewayName] || ADAPTERS[primaryName]).verifyWebhookSignature(rawBody, signature);
}

// Identify the reference (and best-guess gateway) from an incoming webhook by trying each
// adapter's parser. The stored payment record is the authority on which gateway to verify with.
export function parseWebhookEvent(rawBody) {
  for (const name of Object.keys(ADAPTERS)) {
    try {
      const ev = ADAPTERS[name].parseWebhookEvent(rawBody);
      if (ev && ev.reference) return { ...ev, gateway: name };
    } catch { /* try the next parser */ }
  }
  return { reference: undefined, isPaymentSuccess: false, gateway: primaryName };
}

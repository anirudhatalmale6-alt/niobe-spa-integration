// Gateway selector. The deposit / auto-confirm flow talks only to this module, so the
// underlying payment provider can be swapped with a single config value (PAYMENT_GATEWAY)
// without touching bookings.js, server.js or the customer-facing pages.
import { CONFIG } from './config.js';
import * as paystack from './paystack.js';
import * as hubtel from './hubtel.js';

const GATEWAYS = { paystack, hubtel };

const active = GATEWAYS[CONFIG.gateway] || hubtel;

export const displayName = active.displayName;
export const initializeTransaction = active.initializeTransaction;
export const verifyTransaction = active.verifyTransaction;
export const verifyWebhookSignature = active.verifyWebhookSignature;
export const parseWebhookEvent = active.parseWebhookEvent;

import { CONFIG, branchById } from './config.js';
import { ssPost } from './simplespa.js';

const STATUS_CONFIRMED = 20; // SimpleSpa: 20 = Confirmed

// Flip an appointment to "Confirmed" in SimpleSpa once payment has cleared, stamping the
// unique payment reference into the status/audit log. Requires the branch key to be in
// Write mode (Mode 3). Falls back to a simulated result when the key isn't in place yet.
export async function confirmAppointment(branchId, appointmentId, paymentReference) {
  const branch = branchById(branchId);
  if (!branch) throw new Error(`Unknown branch: ${branchId}`);

  const canWriteLive = !CONFIG.demoMode && branch.key;
  if (!canWriteLive) {
    return {
      simulated: true,
      branchId,
      appointment_id: appointmentId,
      new_status: STATUS_CONFIRMED,
      status_label: 'Confirmed',
      reason: `deposit_ref:${paymentReference}`,
    };
  }

  try {
    const result = await ssPost(branch, 'write/appointment-status.php', {
      appointment_id: appointmentId,
      status: STATUS_CONFIRMED,
      reason: `deposit_ref:${paymentReference}`,
    });
    return { confirmed: true, simulated: false, branchId, ...result };
  } catch (err) {
    // The payment has ALREADY succeeded by the time we get here, so a failure to write the
    // status back to SimpleSpa must NOT fail the customer. This happens when the write API
    // isn't enabled on the account yet (404 "File not found"), or a transient error. We flag
    // it so the deposit is recorded for manual/retry confirmation and the customer still sees
    // success. Auto-confirm activates automatically once SimpleSpa enables write access.
    return {
      confirmed: false,
      pending: true,
      needsManualConfirm: true,
      branchId,
      appointment_id: appointmentId,
      reason: `deposit_ref:${paymentReference}`,
      error: err.message,
    };
  }
}

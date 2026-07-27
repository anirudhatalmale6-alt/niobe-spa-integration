import { CONFIG, branchById } from './config.js';
import { ssPost } from './simplespa.js';

const STATUS_CONFIRMED = 20; // SimpleSpa: 20 = Confirmed

// Flip an appointment to "Confirmed" in SimpleSpa once payment has cleared, stamping the
// unique payment reference into the status/audit log. Requires the branch key to be in
// Write mode (Mode 3). Falls back to a simulated result when secrets aren't in place yet.
export async function confirmAppointment(branchId, appointmentId, paymentReference) {
  const branch = branchById(branchId);
  if (!branch) throw new Error(`Unknown branch: ${branchId}`);

  const canWriteLive = !CONFIG.demoMode && branch.key && branch.secret;
  if (!canWriteLive) {
    return {
      simulated: true,
      branchId,
      appointment_id: appointmentId,
      new_status: STATUS_CONFIRMED,
      status_label: 'Confirmed',
      reason: `paystack_ref:${paymentReference}`,
    };
  }

  const result = await ssPost(branch, 'write/appointment-status.php', {
    appointment_id: appointmentId,
    status: STATUS_CONFIRMED,
    reason: `paystack_ref:${paymentReference}`,
  });
  return { simulated: false, branchId, ...result };
}

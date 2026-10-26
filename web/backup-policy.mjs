/* Recovery approval travels only across one aborted/retried IDB operation. */
export const RECOVERY_APPROVALS = Symbol('shard-atlas-recovery-approvals');

export function cloudBackupMode(db) {
  return db.cloudBackupPolicy?.mode === 'cloud' && db.cloudBackupPolicy?.verified === true;
}

export function recoverySnapshot(db) {
  return JSON.parse(JSON.stringify({archive: db.archive, drafts: db.drafts || {}, imports: db.imports || [],
    inboxReceipts: db.inboxReceipts || [], capsuleExtras: db.librarySync?.capsuleExtras || {}}));
}

export function recoveryApproval(db, snapshot) {
  if (!cloudBackupMode(db)) return null;
  // Exact serialized equality avoids accepting a receipt for a different draft,
  // receipt, or collection after another tab changes state during the upload.
  const key = JSON.stringify(snapshot);
  const receipt = db[RECOVERY_APPROVALS]?.get(key);
  if (receipt) return receipt;
  const error = new Error('Preparing a cloud recovery copy before changing this device.');
  error.code = 'cloud_backup_required';
  error.status = 503;
  error.snapshot = snapshot;
  error.recoveryKey = key;
  throw error;
}

export function validateRecoveryReceipt(receipt) {
  if (!receipt || typeof receipt.id !== 'string' || !receipt.id || receipt.verified !== true) {
    throw Object.assign(new Error('The recovery upload was not verified. Your previous data is retained.'), {status: 503});
  }
  return receipt;
}

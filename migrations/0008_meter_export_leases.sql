ALTER TABLE meter_exports ADD COLUMN lease_token TEXT;
ALTER TABLE meter_exports ADD COLUMN lease_expires_at INTEGER;

CREATE INDEX meter_exports_lease_queue_idx
  ON meter_exports (
    reconciliation_state, status, next_attempt_at, lease_expires_at,
    retry_deadline_at, created_at
  );

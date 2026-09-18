ALTER TABLE meter_exports ADD COLUMN first_attempt_at INTEGER;
ALTER TABLE meter_exports ADD COLUMN last_attempt_at INTEGER;
ALTER TABLE meter_exports ADD COLUMN retry_deadline_at INTEGER;
ALTER TABLE meter_exports ADD COLUMN delivery_state TEXT NOT NULL DEFAULT 'not_attempted'
  CHECK (delivery_state IN ('not_attempted', 'ambiguous', 'confirmed', 'rejected'));
ALTER TABLE meter_exports ADD COLUMN reconciliation_state TEXT NOT NULL DEFAULT 'automatic'
  CHECK (reconciliation_state IN ('automatic', 'manual_reconciliation'));

CREATE INDEX meter_exports_reconciliation_queue_idx
  ON meter_exports (reconciliation_state, status, next_attempt_at, retry_deadline_at, created_at);

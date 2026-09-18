ALTER TABLE subscriptions ADD COLUMN reconciliation_attempted_at INTEGER;
ALTER TABLE subscriptions ADD COLUMN reconciliation_next_attempt_at INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN reconciliation_failure_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE subscriptions ADD COLUMN reconciliation_last_error TEXT;

CREATE INDEX IF NOT EXISTS subscriptions_reconciliation_queue_idx
  ON subscriptions (reconciliation_next_attempt_at, updated_at, stripe_subscription_id);

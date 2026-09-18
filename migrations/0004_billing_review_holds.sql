CREATE TABLE IF NOT EXISTS billing_review_holds (
  billing_account_id TEXT PRIMARY KEY REFERENCES billing_accounts(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('dispute', 'refund')),
  stripe_object_id TEXT NOT NULL,
  stripe_object_json TEXT NOT NULL,
  source_event_id TEXT NOT NULL UNIQUE REFERENCES stripe_events(id) ON DELETE RESTRICT,
  last_event_created INTEGER NOT NULL CHECK (last_event_created >= 0),
  last_event_id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS billing_review_holds_event_order_idx
  ON billing_review_holds (last_event_created, last_event_id);

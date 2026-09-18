CREATE TABLE billing_review_holds_next (
  billing_account_id TEXT NOT NULL REFERENCES billing_accounts(id) ON DELETE RESTRICT,
  reason TEXT NOT NULL CHECK (reason IN ('dispute', 'refund')),
  stripe_object_id TEXT NOT NULL,
  stripe_object_json TEXT NOT NULL,
  source_event_id TEXT NOT NULL UNIQUE REFERENCES stripe_events(id) ON DELETE RESTRICT,
  last_event_created INTEGER NOT NULL CHECK (last_event_created >= 0),
  last_event_id TEXT NOT NULL,
  released_by_event_id TEXT UNIQUE REFERENCES stripe_events(id) ON DELETE RESTRICT,
  released_event_created INTEGER CHECK (released_event_created >= 0),
  released_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (billing_account_id, reason, stripe_object_id),
  CHECK (
    (released_by_event_id IS NULL AND released_event_created IS NULL AND released_at IS NULL)
    OR
    (released_by_event_id IS NOT NULL AND released_event_created IS NOT NULL AND released_at IS NOT NULL)
  )
);

INSERT INTO billing_review_holds_next (
  billing_account_id, reason, stripe_object_id, stripe_object_json,
  source_event_id, last_event_created, last_event_id, created_at, updated_at
)
SELECT
  billing_account_id, reason, stripe_object_id, stripe_object_json,
  source_event_id, last_event_created, last_event_id, created_at, updated_at
FROM billing_review_holds;

DROP TABLE billing_review_holds;
ALTER TABLE billing_review_holds_next RENAME TO billing_review_holds;

CREATE INDEX billing_review_holds_event_order_idx
  ON billing_review_holds (last_event_created, last_event_id);

CREATE INDEX billing_review_holds_active_account_idx
  ON billing_review_holds (billing_account_id, released_by_event_id);

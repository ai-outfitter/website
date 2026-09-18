ALTER TABLE subscriptions ADD COLUMN auditability_stripe_item_id TEXT;
ALTER TABLE subscriptions ADD COLUMN auditability_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (auditability_enabled IN (0, 1));

ALTER TABLE entitlements ADD COLUMN auditability_enabled INTEGER NOT NULL DEFAULT 0
  CHECK (auditability_enabled IN (0, 1));

ALTER TABLE residents ADD COLUMN pensieve_profile TEXT;
ALTER TABLE residents ADD COLUMN pensieve_desired_state TEXT NOT NULL DEFAULT 'disabled'
  CHECK (pensieve_desired_state IN ('disabled', 'provisioning', 'active', 'suspended'));
ALTER TABLE residents ADD COLUMN pensieve_observed_state TEXT NOT NULL DEFAULT 'disabled'
  CHECK (pensieve_observed_state IN ('disabled', 'pending', 'ready', 'degraded', 'non-conforming', 'error'));
ALTER TABLE residents ADD COLUMN pensieve_evidence_json TEXT;

CREATE UNIQUE INDEX subscriptions_auditability_item_idx
  ON subscriptions (auditability_stripe_item_id)
  WHERE auditability_stripe_item_id IS NOT NULL;

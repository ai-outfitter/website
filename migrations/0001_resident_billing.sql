PRAGMA foreign_keys = ON;

CREATE TABLE billing_accounts (
  id TEXT PRIMARY KEY,
  tenant_key TEXT NOT NULL UNIQUE,
  github_account_id TEXT NOT NULL,
  github_account_login TEXT NOT NULL COLLATE NOCASE,
  github_account_type TEXT NOT NULL CHECK (github_account_type IN ('Organization', 'User')),
  github_installation_id TEXT NOT NULL UNIQUE,
  created_by_github_user_id TEXT NOT NULL,
  created_by_github_login TEXT NOT NULL COLLATE NOCASE,
  stripe_customer_id TEXT NOT NULL UNIQUE,
  authorization_state TEXT NOT NULL DEFAULT 'authorized'
    CHECK (authorization_state IN ('pending', 'authorized', 'suspended', 'revoked')),
  markup_basis_points INTEGER NOT NULL CHECK (markup_basis_points >= 0),
  hard_spend_limit_micros INTEGER CHECK (
    hard_spend_limit_micros IS NULL OR hard_spend_limit_micros >= 0
  ),
  alert_threshold_micros INTEGER CHECK (
    alert_threshold_micros IS NULL OR alert_threshold_micros >= 0
  ),
  accepted_rate_card_version TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CHECK (
    hard_spend_limit_micros IS NULL OR alert_threshold_micros IS NULL
      OR alert_threshold_micros <= hard_spend_limit_micros
  ),
  UNIQUE (github_account_id)
);

CREATE TABLE stripe_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  event_created INTEGER NOT NULL CHECK (event_created >= 0),
  object_id TEXT,
  raw_json TEXT NOT NULL,
  processing_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (processing_status IN ('pending', 'applied', 'ignored', 'failed')),
  processing_error TEXT,
  received_at INTEGER NOT NULL,
  processed_at INTEGER
);

CREATE INDEX stripe_events_processing_idx
  ON stripe_events (processing_status, received_at);

CREATE TABLE pending_checkout_leases (
  id TEXT PRIMARY KEY,
  billing_account_id TEXT NOT NULL REFERENCES billing_accounts(id) ON DELETE RESTRICT,
  product_key TEXT NOT NULL,
  idempotency_key TEXT NOT NULL UNIQUE,
  stripe_checkout_session_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'session_created', 'completed', 'expired', 'released')),
  expires_at INTEGER NOT NULL CHECK (expires_at >= 0),
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (billing_account_id, product_key)
);

CREATE INDEX pending_checkout_leases_expiry_idx
  ON pending_checkout_leases (status, expires_at);

CREATE TABLE subscriptions (
  stripe_subscription_id TEXT PRIMARY KEY,
  billing_account_id TEXT NOT NULL REFERENCES billing_accounts(id) ON DELETE RESTRICT,
  stripe_subscription_item_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL CHECK (status IN (
    'incomplete', 'incomplete_expired', 'trialing', 'active', 'past_due',
    'canceled', 'unpaid', 'paused'
  )),
  current_period_start INTEGER NOT NULL CHECK (current_period_start >= 0),
  current_period_end INTEGER NOT NULL CHECK (current_period_end >= current_period_start),
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0, 1)),
  resident_quantity INTEGER NOT NULL DEFAULT 1 CHECK (resident_quantity = 1),
  last_event_created INTEGER NOT NULL CHECK (last_event_created >= 0),
  last_event_id TEXT NOT NULL REFERENCES stripe_events(id) ON DELETE RESTRICT,
  stripe_object_json TEXT NOT NULL,
  reconciled_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE INDEX subscriptions_account_idx
  ON subscriptions (billing_account_id, status);

CREATE TABLE entitlements (
  billing_account_id TEXT PRIMARY KEY REFERENCES billing_accounts(id) ON DELETE RESTRICT,
  stripe_subscription_id TEXT NOT NULL UNIQUE
    REFERENCES subscriptions(stripe_subscription_id) ON DELETE RESTRICT,
  status TEXT NOT NULL CHECK (status IN ('active', 'suspended')),
  provision_enabled INTEGER NOT NULL CHECK (provision_enabled IN (0, 1)),
  wake_enabled INTEGER NOT NULL CHECK (wake_enabled IN (0, 1)),
  inference_enabled INTEGER NOT NULL CHECK (inference_enabled IN (0, 1)),
  paid_through INTEGER NOT NULL CHECK (paid_through >= 0),
  source_event_id TEXT NOT NULL REFERENCES stripe_events(id) ON DELETE RESTRICT,
  updated_at INTEGER NOT NULL
);

CREATE TABLE residents (
  id TEXT PRIMARY KEY,
  billing_account_id TEXT NOT NULL UNIQUE REFERENCES billing_accounts(id) ON DELETE RESTRICT,
  agent_resource_name TEXT NOT NULL UNIQUE,
  persona_login TEXT,
  starting_workflow TEXT NOT NULL DEFAULT 'issue-triage'
    CHECK (starting_workflow = 'issue-triage'),
  desired_state TEXT NOT NULL DEFAULT 'provisioning'
    CHECK (desired_state IN ('provisioning', 'active', 'suspended')),
  observed_state TEXT NOT NULL DEFAULT 'pending'
    CHECK (observed_state IN ('pending', 'ready', 'error', 'suspended')),
  observed_generation INTEGER CHECK (observed_generation IS NULL OR observed_generation >= 0),
  pinned_catalog_revision TEXT,
  ready_evidence_json TEXT,
  suspended_at INTEGER,
  suspension_reason TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE provisioning_operations (
  id TEXT PRIMARY KEY,
  billing_account_id TEXT NOT NULL REFERENCES billing_accounts(id) ON DELETE RESTRICT,
  resident_id TEXT NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  desired_revision TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'approved', 'running', 'succeeded', 'failed')),
  approval_state TEXT NOT NULL DEFAULT 'required'
    CHECK (approval_state IN ('required', 'approved', 'rejected')),
  approved_by TEXT,
  approved_at INTEGER,
  approval_evidence_json TEXT,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  claimed_by TEXT,
  claim_token TEXT UNIQUE,
  claim_expires_at INTEGER,
  evidence_json TEXT,
  deployment_callback_issuer TEXT,
  deployment_callback_subject TEXT,
  completed_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE (resident_id, desired_revision)
);

CREATE INDEX provisioning_operations_queue_idx
  ON provisioning_operations (approval_state, status, claim_expires_at, created_at);

CREATE TABLE inference_usage_events (
  id TEXT PRIMARY KEY,
  billing_account_id TEXT NOT NULL REFERENCES billing_accounts(id) ON DELETE RESTRICT,
  resident_id TEXT NOT NULL REFERENCES residents(id) ON DELETE RESTRICT,
  request_id TEXT NOT NULL,
  request_body_digest TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input_tokens INTEGER NOT NULL CHECK (input_tokens >= 0),
  output_tokens INTEGER NOT NULL CHECK (output_tokens >= 0),
  cache_read_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_read_tokens >= 0),
  cache_write_tokens INTEGER NOT NULL DEFAULT 0 CHECK (cache_write_tokens >= 0),
  rate_card_version TEXT NOT NULL,
  provider_cost_micros INTEGER NOT NULL CHECK (provider_cost_micros >= 0),
  markup_basis_points INTEGER NOT NULL CHECK (markup_basis_points >= 0),
  markup_micros INTEGER NOT NULL CHECK (markup_micros >= 0),
  occurred_at INTEGER NOT NULL CHECK (occurred_at >= 0),
  recorded_at INTEGER NOT NULL,
  UNIQUE (resident_id, request_id)
);

CREATE INDEX inference_usage_account_time_idx
  ON inference_usage_events (billing_account_id, occurred_at);

CREATE INDEX inference_usage_resident_time_idx
  ON inference_usage_events (resident_id, occurred_at);

CREATE TRIGGER inference_usage_events_immutable_update
BEFORE UPDATE ON inference_usage_events
BEGIN
  SELECT RAISE(ABORT, 'inference usage events are immutable');
END;

CREATE TRIGGER inference_usage_events_immutable_delete
BEFORE DELETE ON inference_usage_events
BEGIN
  SELECT RAISE(ABORT, 'inference usage events are immutable');
END;

CREATE TABLE meter_exports (
  usage_event_id TEXT NOT NULL REFERENCES inference_usage_events(id) ON DELETE RESTRICT,
  meter_kind TEXT NOT NULL CHECK (meter_kind IN ('provider_cost', 'markup')),
  stripe_meter_event_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'exported', 'failed')),
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error TEXT,
  next_attempt_at INTEGER,
  exported_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (usage_event_id, meter_kind)
);

CREATE INDEX meter_exports_queue_idx
  ON meter_exports (status, next_attempt_at, created_at);

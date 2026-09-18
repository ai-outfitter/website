export type GitHubAccountType = "Organization" | "User";
export type SubscriptionStatus =
  | "incomplete"
  | "incomplete_expired"
  | "trialing"
  | "active"
  | "past_due"
  | "canceled"
  | "unpaid"
  | "paused";
export type MeterKind = "provider_cost" | "markup";
export type MeterExportStatus = "pending" | "exported" | "failed";
export type MeterDeliveryState = "not_attempted" | "ambiguous" | "confirmed" | "rejected";
export type MeterReconciliationState = "automatic" | "manual_reconciliation";

export type CheckoutLease = {
  id: string;
  billingAccountId: string;
  productKey: string;
  idempotencyKey: string;
  stripeCheckoutSessionId: string | null;
  status: "pending" | "session_created" | "completed" | "expired" | "released";
  expiresAt: number;
  createdAt: number;
  updatedAt: number;
};

export type BillingAccount = {
  id: string;
  tenantKey: string;
  githubAccountId: string;
  githubAccountLogin: string;
  githubAccountType: GitHubAccountType;
  githubInstallationId: string;
  createdByGitHubUserId: string;
  createdByGitHubLogin: string;
  stripeCustomerId: string;
  authorizationState: "pending" | "authorized" | "suspended" | "revoked";
  markupBasisPoints: number;
  hardSpendLimitMicros: number | null;
  alertThresholdMicros: number | null;
  acceptedRateCardVersion: string;
  createdAt: number;
  updatedAt: number;
};

export type Subscription = {
  stripeSubscriptionId: string;
  billingAccountId: string;
  stripeSubscriptionItemId: string;
  auditabilityStripeItemId: string | null;
  auditabilityEnabled: boolean;
  status: SubscriptionStatus;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  residentQuantity: 1;
  lastEventCreated: number;
  lastEventId: string;
  stripeObjectJson: string;
  reconciledAt: number | null;
  createdAt: number;
  updatedAt: number;
};

export type Resident = {
  id: string;
  billingAccountId: string;
  agentResourceName: string;
  personaLogin: string | null;
  startingWorkflow: "issue-triage";
  desiredState: "provisioning" | "active" | "suspended";
  observedState: "pending" | "ready" | "error" | "suspended";
  observedGeneration: number | null;
  pinnedCatalogRevision: string | null;
  readyEvidenceJson: string | null;
  suspendedAt: number | null;
  suspensionReason: string | null;
  pensieveProfile: string | null;
  pensieveDesiredState: "disabled" | "provisioning" | "active" | "suspended";
  pensieveObservedState: "disabled" | "pending" | "ready" | "degraded" | "non-conforming" | "error";
  pensieveEvidenceJson: string | null;
};

export type AccountBillingStatus = {
  account: BillingAccount;
  subscription: Subscription | null;
  resident: Resident | null;
  entitlement: {
    status: "active" | "suspended";
    provisionEnabled: boolean;
    wakeEnabled: boolean;
    inferenceEnabled: boolean;
    auditabilityEnabled: boolean;
    paidThrough: number;
  } | null;
};

export type CheckoutBillingStatus = AccountBillingStatus & {
  checkoutLease: CheckoutLease;
};

export type ProvisioningOperation = {
  id: string;
  billingAccountId: string;
  residentId: string;
  desiredRevision: string;
  status: "pending" | "approved" | "running" | "succeeded" | "failed";
  approvalState: "required" | "approved" | "rejected";
  approvedBy: string | null;
  approvedAt: number | null;
  approvalEvidenceJson: string | null;
  attemptCount: number;
  claimedBy: string | null;
  claimToken: string | null;
  claimExpiresAt: number | null;
  evidenceJson: string | null;
  lastError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type SubscriptionLifecycleEvent = {
  eventId: string;
  eventType: string;
  eventCreated: number;
  rawJson: string;
  stripeObjectJson: string;
  reconciledAt?: number | null;
  authoritative?: boolean;
  billingAccountId: string;
  stripeSubscriptionId: string;
  stripeSubscriptionItemId: string;
  auditabilityStripeItemId: string | null;
  auditabilityEnabled: boolean;
  pensieveProfile: string | null;
  status: SubscriptionStatus;
  currentPeriodStart: number;
  currentPeriodEnd: number;
  cancelAtPeriodEnd: boolean;
  residentQuantity: 1;
  agentResourceName: string;
  personaLogin?: string | null;
  provisioningApprovalActor?: string;
  provisioningApprovalEvidenceJson?: string;
  receivedAt?: number;
};

export type BillingReviewEvent = {
  eventId: string;
  eventType: string;
  eventCreated: number;
  rawJson: string;
  stripeObjectId: string;
  stripeObjectJson: string;
  billingAccountId: string;
  reason: "dispute" | "refund";
  receivedAt?: number;
};

export type InferenceUsage = {
  id: string;
  billingAccountId: string;
  residentId: string;
  requestId: string;
  requestBodyDigest: string;
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  rateCardVersion: string;
  providerCostMicros: number;
  markupBasisPoints: number;
  markupMicros: number;
  occurredAt: number;
  recordedAt?: number;
};

export type MeterExport = {
  usageEventId: string;
  meterKind: MeterKind;
  stripeMeterEventId: string | null;
  status: MeterExportStatus;
  attemptCount: number;
  lastError: string | null;
  nextAttemptAt: number | null;
  exportedAt: number | null;
  firstAttemptAt: number | null;
  lastAttemptAt: number | null;
  retryDeadlineAt: number | null;
  deliveryState: MeterDeliveryState;
  reconciliationState: MeterReconciliationState;
};

export type PendingMeterExport = MeterExport & {
  stripeCustomerId: string;
  eventTimestamp: number;
  amountMicros: number;
};

export type UsageBillingPolicy = {
  billingAccountId: string;
  residentId: string;
  markupBasisPoints: number;
  acceptedRateCardVersion: string;
  hardSpendLimitMicros: number | null;
  currentPeriodStart: number;
  currentPeriodEnd: number;
};

export type InferenceAuthorization =
  | { authorized: false; reason: "not_entitled"; residentId: string }
  | (UsageBillingPolicy & {
    authorized: boolean;
    reason: "authorized" | "not_entitled" | "spend_limit_reached";
    periodSpendMicros: number;
    remainingHardSpendLimitMicros: number | null;
  });

type BillingAccountRow = {
  id: string;
  tenant_key: string;
  github_account_id: string;
  github_account_login: string;
  github_account_type: GitHubAccountType;
  github_installation_id: string;
  created_by_github_user_id: string;
  created_by_github_login: string;
  stripe_customer_id: string;
  authorization_state: BillingAccount["authorizationState"];
  markup_basis_points: number;
  hard_spend_limit_micros: number | null;
  alert_threshold_micros: number | null;
  accepted_rate_card_version: string;
  created_at: number;
  updated_at: number;
};

type SubscriptionRow = {
  stripe_subscription_id: string;
  billing_account_id: string;
  stripe_subscription_item_id: string;
  auditability_stripe_item_id: string | null;
  auditability_enabled: number;
  status: SubscriptionStatus;
  current_period_start: number;
  current_period_end: number;
  cancel_at_period_end: number;
  resident_quantity: 1;
  last_event_created: number;
  last_event_id: string;
  stripe_object_json: string;
  reconciled_at: number | null;
  created_at: number;
  updated_at: number;
};

type ResidentRow = {
  id: string;
  billing_account_id: string;
  agent_resource_name: string;
  persona_login: string | null;
  starting_workflow: "issue-triage";
  desired_state: Resident["desiredState"];
  observed_state: Resident["observedState"];
  observed_generation: number | null;
  pinned_catalog_revision: string | null;
  ready_evidence_json: string | null;
  suspended_at: number | null;
  suspension_reason: string | null;
  pensieve_profile: string | null;
  pensieve_desired_state: Resident["pensieveDesiredState"];
  pensieve_observed_state: Resident["pensieveObservedState"];
  pensieve_evidence_json: string | null;
};

type UsageRow = {
  id: string;
  billing_account_id: string;
  resident_id: string;
  request_id: string;
  request_body_digest: string;
  provider: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  rate_card_version: string;
  provider_cost_micros: number;
  markup_basis_points: number;
  markup_micros: number;
  occurred_at: number;
  recorded_at: number;
};

type MeterExportRow = {
  usage_event_id: string;
  meter_kind: MeterKind;
  stripe_meter_event_id: string | null;
  status: MeterExportStatus;
  attempt_count: number;
  last_error: string | null;
  next_attempt_at: number | null;
  exported_at: number | null;
  first_attempt_at: number | null;
  last_attempt_at: number | null;
  retry_deadline_at: number | null;
  delivery_state: MeterDeliveryState;
  reconciliation_state: MeterReconciliationState;
};

export type PendingMeterExportRow = MeterExportRow & {
  stripe_customer_id: string;
  occurred_at: number;
  provider_cost_micros: number;
  markup_micros: number;
};

type UsageBillingPolicyRow = {
  billing_account_id: string;
  resident_id: string;
  markup_basis_points: number;
  accepted_rate_card_version: string;
  hard_spend_limit_micros: number | null;
  current_period_start: number;
  current_period_end: number;
};

type InferenceAuthorizationRow = UsageBillingPolicyRow & {
  authorization_state: BillingAccount["authorizationState"];
  entitlement_status: "active" | "suspended";
  inference_enabled: number;
  desired_state: Resident["desiredState"];
  observed_state: Resident["observedState"];
  subscription_status: SubscriptionStatus;
  period_spend_micros: number;
};

type CheckoutLeaseRow = {
  id: string;
  billing_account_id: string;
  product_key: string;
  idempotency_key: string;
  stripe_checkout_session_id: string | null;
  status: CheckoutLease["status"];
  expires_at: number;
  created_at: number;
  updated_at: number;
};

type ProvisioningOperationRow = {
  id: string;
  billing_account_id: string;
  resident_id: string;
  desired_revision: string;
  status: ProvisioningOperation["status"];
  approval_state: ProvisioningOperation["approvalState"];
  approved_by: string | null;
  approved_at: number | null;
  approval_evidence_json: string | null;
  attempt_count: number;
  claimed_by: string | null;
  claim_token: string | null;
  claim_expires_at: number | null;
  evidence_json: string | null;
  last_error: string | null;
  created_at: number;
  updated_at: number;
};

export type LifecycleState = {
  lastEventCreated: number;
  lastEventId: string;
  residentExists: boolean;
  provisioningOperationExists: boolean;
};

export function compareStripeEvents(
  left: Pick<SubscriptionLifecycleEvent, "eventCreated" | "eventId">,
  right: Pick<SubscriptionLifecycleEvent, "eventCreated" | "eventId">,
) {
  if (left.eventCreated !== right.eventCreated) return left.eventCreated - right.eventCreated;
  return left.eventId === right.eventId ? 0 : left.eventId > right.eventId ? 1 : -1;
}

export function reduceSubscriptionLifecycle(state: LifecycleState | null, event: SubscriptionLifecycleEvent) {
  const applies = state === null || compareStripeEvents(event, {
    eventCreated: state.lastEventCreated,
    eventId: state.lastEventId,
  }) > 0;
  return {
    applies,
    createResident: applies && event.status === "active" && !state?.residentExists,
    createProvisioningOperation: applies && event.status === "active" && !state?.provisioningOperationExists,
    state: applies ? {
      lastEventCreated: event.eventCreated,
      lastEventId: event.eventId,
      residentExists: state?.residentExists || event.status === "active",
      provisioningOperationExists: state?.provisioningOperationExists || event.status === "active",
    } : state,
  };
}

export function provisioningApprovalFromEvent(event: SubscriptionLifecycleEvent) {
  const hasActor = event.provisioningApprovalActor !== undefined;
  const hasEvidence = event.provisioningApprovalEvidenceJson !== undefined;
  if (!hasActor && !hasEvidence) return null;
  if (!hasActor || !hasEvidence) {
    throw new TypeError("Provisioning approval requires both actor and evidence");
  }
  if (!event.authoritative || ![
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
  ].includes(event.eventType)) {
    throw new TypeError("Provisioning approval requires an authoritative successful Checkout event");
  }
  assertString(event.provisioningApprovalActor!, "provisioningApprovalActor");
  assertString(event.provisioningApprovalEvidenceJson!, "provisioningApprovalEvidenceJson");
  return {
    actor: event.provisioningApprovalActor!,
    evidenceJson: event.provisioningApprovalEvidenceJson!,
  };
}

export function reduceProvisioningApproval(
  current: { approvalState: "required" | "approved" | "rejected"; actor: string | null; evidenceJson: string | null },
  event: SubscriptionLifecycleEvent,
) {
  const approval = provisioningApprovalFromEvent(event);
  if (!approval || current.approvalState !== "required") return current;
  return { approvalState: "approved" as const, actor: approval.actor, evidenceJson: approval.evidenceJson };
}

function assertString(value: string, name: string) {
  if (!value.trim()) throw new TypeError(`${name} must not be empty`);
}

function assertInteger(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`${name} must be a non-negative safe integer`);
  }
}

function accountFromRow(row: BillingAccountRow): BillingAccount {
  return {
    id: row.id,
    tenantKey: row.tenant_key,
    githubAccountId: row.github_account_id,
    githubAccountLogin: row.github_account_login,
    githubAccountType: row.github_account_type,
    githubInstallationId: row.github_installation_id,
    createdByGitHubUserId: row.created_by_github_user_id,
    createdByGitHubLogin: row.created_by_github_login,
    stripeCustomerId: row.stripe_customer_id,
    authorizationState: row.authorization_state,
    markupBasisPoints: row.markup_basis_points,
    hardSpendLimitMicros: row.hard_spend_limit_micros,
    alertThresholdMicros: row.alert_threshold_micros,
    acceptedRateCardVersion: row.accepted_rate_card_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function subscriptionFromRow(row: SubscriptionRow): Subscription {
  return {
    stripeSubscriptionId: row.stripe_subscription_id,
    billingAccountId: row.billing_account_id,
    stripeSubscriptionItemId: row.stripe_subscription_item_id,
    auditabilityStripeItemId: row.auditability_stripe_item_id,
    auditabilityEnabled: Boolean(row.auditability_enabled),
    status: row.status,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    cancelAtPeriodEnd: Boolean(row.cancel_at_period_end),
    residentQuantity: row.resident_quantity,
    lastEventCreated: row.last_event_created,
    lastEventId: row.last_event_id,
    stripeObjectJson: row.stripe_object_json,
    reconciledAt: row.reconciled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function residentFromRow(row: ResidentRow): Resident {
  return {
    id: row.id,
    billingAccountId: row.billing_account_id,
    agentResourceName: row.agent_resource_name,
    personaLogin: row.persona_login,
    startingWorkflow: row.starting_workflow,
    desiredState: row.desired_state,
    observedState: row.observed_state,
    observedGeneration: row.observed_generation,
    pinnedCatalogRevision: row.pinned_catalog_revision,
    readyEvidenceJson: row.ready_evidence_json,
    suspendedAt: row.suspended_at,
    suspensionReason: row.suspension_reason,
    pensieveProfile: row.pensieve_profile,
    pensieveDesiredState: row.pensieve_desired_state,
    pensieveObservedState: row.pensieve_observed_state,
    pensieveEvidenceJson: row.pensieve_evidence_json,
  };
}

function usageFromRow(row: UsageRow): Required<InferenceUsage> {
  return {
    id: row.id,
    billingAccountId: row.billing_account_id,
    residentId: row.resident_id,
    requestId: row.request_id,
    requestBodyDigest: row.request_body_digest,
    provider: row.provider,
    model: row.model,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    cacheReadTokens: row.cache_read_tokens,
    cacheWriteTokens: row.cache_write_tokens,
    rateCardVersion: row.rate_card_version,
    providerCostMicros: row.provider_cost_micros,
    markupBasisPoints: row.markup_basis_points,
    markupMicros: row.markup_micros,
    occurredAt: row.occurred_at,
    recordedAt: row.recorded_at,
  };
}

function meterExportFromRow(row: MeterExportRow): MeterExport {
  return {
    usageEventId: row.usage_event_id,
    meterKind: row.meter_kind,
    stripeMeterEventId: row.stripe_meter_event_id,
    status: row.status,
    attemptCount: row.attempt_count,
    lastError: row.last_error,
    nextAttemptAt: row.next_attempt_at,
    exportedAt: row.exported_at,
    firstAttemptAt: row.first_attempt_at,
    lastAttemptAt: row.last_attempt_at,
    retryDeadlineAt: row.retry_deadline_at,
    deliveryState: row.delivery_state,
    reconciliationState: row.reconciliation_state,
  };
}

export function pendingMeterExportFromRow(row: PendingMeterExportRow): PendingMeterExport {
  return {
    ...meterExportFromRow(row),
    stripeCustomerId: row.stripe_customer_id,
    eventTimestamp: row.occurred_at,
    amountMicros: row.meter_kind === "provider_cost"
      ? row.provider_cost_micros
      : row.markup_micros,
  };
}

function usagePolicyFromRow(row: UsageBillingPolicyRow): UsageBillingPolicy {
  return {
    billingAccountId: row.billing_account_id,
    residentId: row.resident_id,
    markupBasisPoints: row.markup_basis_points,
    acceptedRateCardVersion: row.accepted_rate_card_version,
    hardSpendLimitMicros: row.hard_spend_limit_micros,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
  };
}

export function billedMarkupMicros(providerCostMicros: number, markupBasisPoints: number) {
  assertInteger(providerCostMicros, "providerCostMicros");
  assertInteger(markupBasisPoints, "markupBasisPoints");
  const rounded = (BigInt(providerCostMicros) * BigInt(markupBasisPoints) + 5_000n) / 10_000n;
  const result = Number(rounded);
  if (!Number.isSafeInteger(result)) throw new TypeError("markupMicros exceeds the safe integer range");
  return result;
}

export function validateUsageBillingPolicy(policy: UsageBillingPolicy, input: InferenceUsage) {
  if (input.billingAccountId !== policy.billingAccountId || input.residentId !== policy.residentId) {
    throw new Error("Usage tenant or resident does not match the trusted billing policy");
  }
  if (input.rateCardVersion !== policy.acceptedRateCardVersion) {
    throw new Error("Usage rate card does not match the account billing policy");
  }
  if (input.markupBasisPoints !== policy.markupBasisPoints) {
    throw new Error("Usage markup basis points do not match the account billing policy");
  }
  const markupMicros = billedMarkupMicros(input.providerCostMicros, policy.markupBasisPoints);
  if (input.markupMicros !== markupMicros) {
    throw new Error("Usage markup amount does not match the account billing policy");
  }
  if (input.occurredAt < policy.currentPeriodStart || input.occurredAt >= policy.currentPeriodEnd) {
    throw new Error("Usage occurred outside the current subscription period");
  }
  return markupMicros;
}

export function spendLimitState(hardSpendLimitMicros: number | null, periodSpendMicros: number) {
  assertInteger(periodSpendMicros, "periodSpendMicros");
  if (hardSpendLimitMicros === null) {
    return { reached: false, remainingMicros: null };
  }
  assertInteger(hardSpendLimitMicros, "hardSpendLimitMicros");
  return {
    reached: periodSpendMicros >= hardSpendLimitMicros,
    remainingMicros: Math.max(0, hardSpendLimitMicros - periodSpendMicros),
  };
}

export function validatePersonaLogin(personaLogin: string) {
  if (!/^(?!-)(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(personaLogin)) {
    throw new TypeError("personaLogin must be a valid GitHub login");
  }
  return personaLogin;
}

export function sameUsageEvent(existing: Required<InferenceUsage>, incoming: InferenceUsage) {
  return existing.id === incoming.id
    && existing.billingAccountId === incoming.billingAccountId
    && existing.residentId === incoming.residentId
    && existing.requestId === incoming.requestId
    && existing.requestBodyDigest === incoming.requestBodyDigest
    && existing.provider === incoming.provider
    && existing.model === incoming.model
    && existing.inputTokens === incoming.inputTokens
    && existing.outputTokens === incoming.outputTokens
    && existing.cacheReadTokens === incoming.cacheReadTokens
    && existing.cacheWriteTokens === incoming.cacheWriteTokens
    && existing.rateCardVersion === incoming.rateCardVersion
    && existing.providerCostMicros === incoming.providerCostMicros
    && existing.markupBasisPoints === incoming.markupBasisPoints
    && existing.markupMicros === incoming.markupMicros
    && existing.occurredAt === incoming.occurredAt;
}

export function resolveUsageDedupe(existing: Required<InferenceUsage> | null, incoming: InferenceUsage) {
  if (!existing) return "insert" as const;
  if (sameUsageEvent(existing, incoming)) return "duplicate" as const;
  throw new Error("A different immutable usage event already exists for this request");
}

export function resolveCheckoutLease(
  existing: CheckoutLease | null,
  hasActiveSubscription: boolean,
  proposed: CheckoutLease,
  now: number,
) {
  if (hasActiveSubscription) throw new Error("An active resident subscription already exists");
  if (existing && existing.expiresAt > now
    && (existing.status === "pending" || existing.status === "session_created")) {
    return { lease: existing, reused: true };
  }
  return { lease: proposed, reused: false };
}

export function isProvisioningClaimable(
  operation: Pick<ProvisioningOperation, "status" | "approvalState" | "claimExpiresAt">,
  now: number,
) {
  if (operation.approvalState !== "approved") return false;
  if (operation.status === "pending" || operation.status === "approved") return true;
  return operation.status === "running"
    && operation.claimExpiresAt !== null
    && operation.claimExpiresAt <= now;
}

function checkoutLeaseFromRow(row: CheckoutLeaseRow): CheckoutLease {
  return {
    id: row.id,
    billingAccountId: row.billing_account_id,
    productKey: row.product_key,
    idempotencyKey: row.idempotency_key,
    stripeCheckoutSessionId: row.stripe_checkout_session_id,
    status: row.status,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function provisioningOperationFromRow(row: ProvisioningOperationRow): ProvisioningOperation {
  return {
    id: row.id,
    billingAccountId: row.billing_account_id,
    residentId: row.resident_id,
    desiredRevision: row.desired_revision,
    status: row.status,
    approvalState: row.approval_state,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
    approvalEvidenceJson: row.approval_evidence_json,
    attemptCount: row.attempt_count,
    claimedBy: row.claimed_by,
    claimToken: row.claim_token,
    claimExpiresAt: row.claim_expires_at,
    evidenceJson: row.evidence_json,
    lastError: row.last_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class BillingStore {
  constructor(private readonly db: D1Database) {}

  async upsertBillingAccount(input: Omit<BillingAccount, "createdAt" | "updatedAt">, now = Date.now()) {
    for (const [name, value] of Object.entries({
      id: input.id,
      tenantKey: input.tenantKey,
      githubAccountId: input.githubAccountId,
      githubAccountLogin: input.githubAccountLogin,
      githubAccountType: input.githubAccountType,
      githubInstallationId: input.githubInstallationId,
      createdByGitHubUserId: input.createdByGitHubUserId,
      createdByGitHubLogin: input.createdByGitHubLogin,
      stripeCustomerId: input.stripeCustomerId,
      authorizationState: input.authorizationState,
      acceptedRateCardVersion: input.acceptedRateCardVersion,
    })) assertString(value, name);
    assertInteger(input.markupBasisPoints, "markupBasisPoints");
    if (input.hardSpendLimitMicros !== null) assertInteger(input.hardSpendLimitMicros, "hardSpendLimitMicros");
    if (input.alertThresholdMicros !== null) assertInteger(input.alertThresholdMicros, "alertThresholdMicros");
    assertInteger(now, "now");
    await this.db.prepare(`
      INSERT INTO billing_accounts (
        id, tenant_key, github_account_id, github_account_login, github_account_type,
        github_installation_id, created_by_github_user_id, created_by_github_login,
        stripe_customer_id, authorization_state, markup_basis_points,
        hard_spend_limit_micros, alert_threshold_micros, accepted_rate_card_version,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(tenant_key) DO UPDATE SET
        github_account_id = excluded.github_account_id,
        github_account_login = excluded.github_account_login,
        github_account_type = excluded.github_account_type,
        github_installation_id = excluded.github_installation_id,
        created_by_github_user_id = excluded.created_by_github_user_id,
        created_by_github_login = excluded.created_by_github_login,
        stripe_customer_id = excluded.stripe_customer_id,
        authorization_state = excluded.authorization_state,
        markup_basis_points = excluded.markup_basis_points,
        hard_spend_limit_micros = excluded.hard_spend_limit_micros,
        alert_threshold_micros = excluded.alert_threshold_micros,
        accepted_rate_card_version = excluded.accepted_rate_card_version,
        updated_at = excluded.updated_at
    `).bind(
      input.id, input.tenantKey, input.githubAccountId, input.githubAccountLogin,
      input.githubAccountType, input.githubInstallationId, input.createdByGitHubUserId,
      input.createdByGitHubLogin, input.stripeCustomerId, input.authorizationState,
      input.markupBasisPoints, input.hardSpendLimitMicros, input.alertThresholdMicros,
      input.acceptedRateCardVersion, now, now,
    ).run();
    return this.getBillingAccountByTenant(input.tenantKey);
  }

  async getBillingAccountByTenant(tenantKey: string) {
    const row = await this.db.prepare("SELECT * FROM billing_accounts WHERE tenant_key = ?")
      .bind(tenantKey).first<BillingAccountRow>();
    return row ? accountFromRow(row) : null;
  }

  async getBillingAccountByGitHubAccountId(githubAccountId: string) {
    assertString(githubAccountId, "githubAccountId");
    const row = await this.db.prepare("SELECT * FROM billing_accounts WHERE github_account_id = ?")
      .bind(githubAccountId).first<BillingAccountRow>();
    return row ? accountFromRow(row) : null;
  }

  async refreshBillingAccountGitHubIdentity(input: {
    billingAccountId: string;
    githubAccountId: string;
    githubAccountLogin: string;
    githubInstallationId: string;
  }, now = Date.now()) {
    for (const [name, value] of Object.entries(input)) assertString(value, name);
    assertInteger(now, "now");
    const result = await this.db.prepare(`
      UPDATE billing_accounts SET
        github_account_login = ?, github_installation_id = ?, updated_at = ?
      WHERE id = ? AND github_account_id = ?
    `).bind(
      input.githubAccountLogin, input.githubInstallationId, now,
      input.billingAccountId, input.githubAccountId,
    ).run();
    if (Number(result.meta.changes ?? 0) !== 1) return null;
    return this.getBillingAccountByGitHubAccountId(input.githubAccountId);
  }

  async getBillingAccountByStripeCustomer(stripeCustomerId: string) {
    const row = await this.db.prepare("SELECT * FROM billing_accounts WHERE stripe_customer_id = ?")
      .bind(stripeCustomerId).first<BillingAccountRow>();
    return row ? accountFromRow(row) : null;
  }

  async acquireCheckoutLease(input: {
    id: string;
    billingAccountId: string;
    productKey: string;
    idempotencyKey: string;
    expiresAt: number;
    now?: number;
  }) {
    for (const [name, value] of Object.entries({
      id: input.id,
      billingAccountId: input.billingAccountId,
      productKey: input.productKey,
      idempotencyKey: input.idempotencyKey,
    })) assertString(value, name);
    const now = input.now ?? Date.now();
    assertInteger(now, "now");
    assertInteger(input.expiresAt, "expiresAt");
    if (input.expiresAt <= now) throw new TypeError("expiresAt must be in the future");
    const session = this.db.withSession("first-primary");
    await session.prepare(`
      INSERT INTO pending_checkout_leases (
        id, billing_account_id, product_key, idempotency_key, status,
        expires_at, created_at, updated_at
      )
      SELECT ?, ?, ?, ?, 'pending', ?, ?, ?
      WHERE NOT EXISTS (
        SELECT 1 FROM subscriptions
        WHERE billing_account_id = ? AND status IN ('active', 'trialing')
      )
      ON CONFLICT(billing_account_id, product_key) DO UPDATE SET
        id = excluded.id,
        idempotency_key = excluded.idempotency_key,
        stripe_checkout_session_id = NULL,
        status = 'pending',
        expires_at = excluded.expires_at,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
      WHERE pending_checkout_leases.expires_at <= ?
         OR pending_checkout_leases.status IN ('completed', 'expired', 'released')
    `).bind(
      input.id, input.billingAccountId, input.productKey, input.idempotencyKey,
      input.expiresAt, now, now, input.billingAccountId, now,
    ).run();
    const active = await session.prepare(`
      SELECT 1 AS found FROM subscriptions
      WHERE billing_account_id = ? AND status IN ('active', 'trialing') LIMIT 1
    `).bind(input.billingAccountId).first<{ found: number }>();
    if (active) throw new Error("An active resident subscription already exists");
    const row = await session.prepare(`
      SELECT * FROM pending_checkout_leases
      WHERE billing_account_id = ? AND product_key = ?
    `).bind(input.billingAccountId, input.productKey).first<CheckoutLeaseRow>();
    if (!row) throw new Error("Checkout lease was not acquired");
    return { lease: checkoutLeaseFromRow(row), reused: row.id !== input.id };
  }

  async attachCheckoutSession(leaseId: string, stripeCheckoutSessionId: string, now = Date.now()) {
    assertString(leaseId, "leaseId");
    assertString(stripeCheckoutSessionId, "stripeCheckoutSessionId");
    assertInteger(now, "now");
    const result = await this.db.prepare(`
      UPDATE pending_checkout_leases SET
        stripe_checkout_session_id = ?, status = 'session_created', updated_at = ?
      WHERE id = ? AND status IN ('pending', 'session_created') AND expires_at > ?
        AND (stripe_checkout_session_id IS NULL OR stripe_checkout_session_id = ?)
    `).bind(stripeCheckoutSessionId, now, leaseId, now, stripeCheckoutSessionId).run();
    return Number(result.meta.changes ?? 0) === 1;
  }

  async getCheckoutStatusBySessionId(
    stripeCheckoutSessionId: string,
    requesterGitHubUserId: string,
  ): Promise<CheckoutBillingStatus | null> {
    assertString(stripeCheckoutSessionId, "stripeCheckoutSessionId");
    assertString(requesterGitHubUserId, "requesterGitHubUserId");
    const lease = await this.db.prepare(`
      SELECT l.* FROM pending_checkout_leases l
      JOIN billing_accounts a ON a.id = l.billing_account_id
      WHERE l.stripe_checkout_session_id = ? AND a.created_by_github_user_id = ?
      LIMIT 1
    `).bind(stripeCheckoutSessionId, requesterGitHubUserId).first<CheckoutLeaseRow>();
    if (!lease) return null;
    const status = await this.getAccountStatus(lease.billing_account_id);
    return status ? { ...status, checkoutLease: checkoutLeaseFromRow(lease) } : null;
  }

  async applySubscriptionEvent(event: SubscriptionLifecycleEvent) {
    this.validateSubscriptionEvent(event);
    const provisioningApproval = provisioningApprovalFromEvent(event);
    const now = event.receivedAt ?? Date.now();
    assertInteger(now, "receivedAt");
    const residentId = `resident:${event.billingAccountId}`;
    const operationId = `provision:${event.billingAccountId}:issue-triage:v1`;
    const stateOperationId = `reconcile:${event.billingAccountId}:${event.eventId}`;
    const desiredState = event.status === "active" ? "active" : "suspended";
    const stateRevision = `resident-state:${desiredState}:${event.eventId}`;
    const eventIsCurrent = event.authoritative
      ? "1 = 1"
      : "last_event_created = ? AND last_event_id = ?";
    const eventIsCurrentArgs = event.authoritative ? [] : [event.eventCreated, event.eventId];
    const prefixedEventIsCurrent = event.authoritative
      ? "1 = 1"
      : "s.last_event_created = ? AND s.last_event_id = ?";
    const session = this.db.withSession("first-primary");

    await session.batch([
      session.prepare(`
        INSERT INTO stripe_events (
          id, event_type, event_created, object_id, raw_json, processing_status, received_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(id) DO NOTHING
      `).bind(event.eventId, event.eventType, event.eventCreated, event.stripeSubscriptionId, event.rawJson, now),
      session.prepare(`
        INSERT INTO subscriptions (
          stripe_subscription_id, billing_account_id, stripe_subscription_item_id,
          auditability_stripe_item_id, auditability_enabled, status,
          current_period_start, current_period_end, cancel_at_period_end, resident_quantity,
          last_event_created, last_event_id, stripe_object_json, reconciled_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(stripe_subscription_id) DO UPDATE SET
          billing_account_id = excluded.billing_account_id,
          stripe_subscription_item_id = excluded.stripe_subscription_item_id,
          auditability_stripe_item_id = excluded.auditability_stripe_item_id,
          auditability_enabled = excluded.auditability_enabled,
          status = excluded.status,
          current_period_start = excluded.current_period_start,
          current_period_end = excluded.current_period_end,
          cancel_at_period_end = excluded.cancel_at_period_end,
          resident_quantity = excluded.resident_quantity,
          last_event_created = CASE
            WHEN excluded.last_event_created > subscriptions.last_event_created
              OR (excluded.last_event_created = subscriptions.last_event_created
                  AND excluded.last_event_id > subscriptions.last_event_id)
            THEN excluded.last_event_created ELSE subscriptions.last_event_created END,
          last_event_id = CASE
            WHEN excluded.last_event_created > subscriptions.last_event_created
              OR (excluded.last_event_created = subscriptions.last_event_created
                  AND excluded.last_event_id > subscriptions.last_event_id)
            THEN excluded.last_event_id ELSE subscriptions.last_event_id END,
          stripe_object_json = excluded.stripe_object_json,
          reconciled_at = excluded.reconciled_at,
          updated_at = excluded.updated_at
        WHERE ${event.authoritative ? "1 = 1" : "excluded.last_event_created > subscriptions.last_event_created"}
           OR (excluded.last_event_created = subscriptions.last_event_created
               AND excluded.last_event_id > subscriptions.last_event_id)
      `).bind(
        event.stripeSubscriptionId, event.billingAccountId, event.stripeSubscriptionItemId,
        event.auditabilityStripeItemId, event.auditabilityEnabled ? 1 : 0,
        event.status, event.currentPeriodStart, event.currentPeriodEnd,
        event.cancelAtPeriodEnd ? 1 : 0, event.residentQuantity, event.eventCreated,
        event.eventId, event.stripeObjectJson, event.reconciledAt ?? null, now, now,
      ),
      session.prepare(`
        INSERT INTO entitlements (
          billing_account_id, stripe_subscription_id, status, provision_enabled,
          wake_enabled, inference_enabled, auditability_enabled,
          paid_through, source_event_id, updated_at
        )
        SELECT billing_account_id, stripe_subscription_id,
          CASE WHEN status = 'active' AND NOT EXISTS (
            SELECT 1 FROM billing_review_holds h
            WHERE h.billing_account_id = subscriptions.billing_account_id
          ) THEN 'active' ELSE 'suspended' END,
          CASE WHEN status = 'active' AND NOT EXISTS (
            SELECT 1 FROM billing_review_holds h
            WHERE h.billing_account_id = subscriptions.billing_account_id
          ) THEN 1 ELSE 0 END,
          CASE WHEN status = 'active' AND NOT EXISTS (
            SELECT 1 FROM billing_review_holds h
            WHERE h.billing_account_id = subscriptions.billing_account_id
          ) THEN 1 ELSE 0 END,
          CASE WHEN status = 'active' AND NOT EXISTS (
            SELECT 1 FROM billing_review_holds h
            WHERE h.billing_account_id = subscriptions.billing_account_id
          ) THEN 1 ELSE 0 END,
          CASE WHEN status = 'active' AND auditability_enabled = 1 AND NOT EXISTS (
            SELECT 1 FROM billing_review_holds h
            WHERE h.billing_account_id = subscriptions.billing_account_id
          ) THEN 1 ELSE 0 END,
          current_period_end, last_event_id, ?
        FROM subscriptions
        WHERE stripe_subscription_id = ? AND ${eventIsCurrent}
        ON CONFLICT(billing_account_id) DO UPDATE SET
          stripe_subscription_id = excluded.stripe_subscription_id,
          status = excluded.status,
          provision_enabled = excluded.provision_enabled,
          wake_enabled = excluded.wake_enabled,
          inference_enabled = excluded.inference_enabled,
          auditability_enabled = excluded.auditability_enabled,
          paid_through = excluded.paid_through,
          source_event_id = excluded.source_event_id,
          updated_at = excluded.updated_at
      `).bind(now, event.stripeSubscriptionId, ...eventIsCurrentArgs),
      session.prepare(`
        INSERT INTO residents (
          id, billing_account_id, agent_resource_name, persona_login, starting_workflow,
          desired_state, observed_state, pensieve_profile, pensieve_desired_state,
          pensieve_observed_state, created_at, updated_at
        )
        SELECT ?, billing_account_id, ?, ?, 'issue-triage', 'provisioning', 'pending', ?,
          CASE WHEN auditability_enabled = 1 THEN 'provisioning' ELSE 'disabled' END,
          CASE WHEN auditability_enabled = 1 THEN 'pending' ELSE 'disabled' END, ?, ?
        FROM subscriptions
        WHERE stripe_subscription_id = ? AND status = 'active' AND ${eventIsCurrent}
          AND NOT EXISTS (
            SELECT 1 FROM billing_review_holds h
            WHERE h.billing_account_id = subscriptions.billing_account_id
          )
        ON CONFLICT(billing_account_id) DO NOTHING
      `).bind(
        residentId, event.agentResourceName, event.personaLogin ?? null,
        event.pensieveProfile, now, now,
        event.stripeSubscriptionId, ...eventIsCurrentArgs,
      ),
      session.prepare(`
        INSERT INTO provisioning_operations (
          id, billing_account_id, resident_id, desired_revision, status,
          approval_state, approved_by, approved_at, approval_evidence_json,
          attempt_count, created_at, updated_at
        )
        SELECT ?, s.billing_account_id, r.id, ?, 'pending', 'approved', ?, ?, ?, 0, ?, ?
        FROM subscriptions s
        JOIN residents r ON r.billing_account_id = s.billing_account_id
        WHERE s.stripe_subscription_id = ? AND ${prefixedEventIsCurrent}
          AND ((s.status = 'active' AND NOT EXISTS (
              SELECT 1 FROM billing_review_holds h
              WHERE h.billing_account_id = s.billing_account_id
            ) AND r.desired_state = 'suspended')
            OR ((s.status <> 'active' OR EXISTS (
              SELECT 1 FROM billing_review_holds h
              WHERE h.billing_account_id = s.billing_account_id
            )) AND r.desired_state <> 'suspended'))
        ON CONFLICT(resident_id, desired_revision) DO NOTHING
      `).bind(
        stateOperationId, stateRevision, `stripe-lifecycle:${event.eventId}`, now,
        JSON.stringify({ eventId: event.eventId, eventType: event.eventType, desiredState }),
        now, now, event.stripeSubscriptionId, ...eventIsCurrentArgs,
      ),
      session.prepare(`
        UPDATE residents SET
          desired_state = CASE
            WHEN EXISTS (
              SELECT 1 FROM subscriptions s
              WHERE stripe_subscription_id = ? AND status = 'active' AND ${eventIsCurrent}
                AND NOT EXISTS (
                  SELECT 1 FROM billing_review_holds h
                  WHERE h.billing_account_id = s.billing_account_id
                )
            ) THEN CASE WHEN observed_state = 'ready' THEN 'active' ELSE 'provisioning' END
            ELSE 'suspended'
          END,
          pensieve_profile = CASE WHEN ? THEN ? ELSE NULL END,
          pensieve_desired_state = CASE
            WHEN ? AND EXISTS (
              SELECT 1 FROM subscriptions s
              WHERE stripe_subscription_id = ? AND status = 'active' AND ${eventIsCurrent}
                AND NOT EXISTS (
                  SELECT 1 FROM billing_review_holds h
                  WHERE h.billing_account_id = s.billing_account_id
                )
            ) THEN CASE WHEN pensieve_observed_state = 'ready' THEN 'active' ELSE 'provisioning' END
            WHEN ? THEN 'suspended'
            ELSE 'disabled'
          END,
          pensieve_observed_state = CASE
            WHEN ? THEN CASE WHEN pensieve_observed_state = 'disabled' THEN 'pending' ELSE pensieve_observed_state END
            ELSE 'disabled'
          END,
          updated_at = ?
        WHERE billing_account_id = ? AND EXISTS (
          SELECT 1 FROM subscriptions
          WHERE stripe_subscription_id = ? AND ${eventIsCurrent}
        )
      `).bind(
        event.stripeSubscriptionId, ...eventIsCurrentArgs,
        event.auditabilityEnabled ? 1 : 0, event.pensieveProfile,
        event.auditabilityEnabled ? 1 : 0, event.stripeSubscriptionId, ...eventIsCurrentArgs,
        event.auditabilityEnabled ? 1 : 0,
        event.auditabilityEnabled ? 1 : 0,
        now,
        event.billingAccountId, event.stripeSubscriptionId, ...eventIsCurrentArgs,
      ),
      session.prepare(`
        INSERT INTO provisioning_operations (
          id, billing_account_id, resident_id, desired_revision, status,
          approval_state, attempt_count, created_at, updated_at
        )
        SELECT ?, s.billing_account_id, r.id, 'issue-triage:v1', 'pending', 'required', 0, ?, ?
        FROM subscriptions s
        JOIN residents r ON r.billing_account_id = s.billing_account_id
        WHERE s.stripe_subscription_id = ? AND s.status = 'active'
          AND ${prefixedEventIsCurrent}
          AND NOT EXISTS (
            SELECT 1 FROM billing_review_holds h
            WHERE h.billing_account_id = s.billing_account_id
          )
        ON CONFLICT(resident_id, desired_revision) DO NOTHING
      `).bind(operationId, now, now, event.stripeSubscriptionId, ...eventIsCurrentArgs),
      ...(provisioningApproval ? [session.prepare(`
        UPDATE provisioning_operations SET
          approval_state = 'approved', approved_by = ?, approved_at = ?,
          approval_evidence_json = ?, updated_at = ?
        WHERE id = ? AND approval_state = 'required'
      `).bind(
        provisioningApproval.actor, now, provisioningApproval.evidenceJson, now, operationId,
      )] : []),
      session.prepare(`
        UPDATE stripe_events SET
          processing_status = CASE WHEN EXISTS (
            SELECT 1 FROM subscriptions
            WHERE stripe_subscription_id = ? AND ${eventIsCurrent}
          ) THEN 'applied' ELSE 'ignored' END,
          processed_at = ?
        WHERE id = ? AND processing_status = 'pending'
      `).bind(event.stripeSubscriptionId, ...eventIsCurrentArgs, now, event.eventId),
    ]);

    const subscription = await session.prepare(
      "SELECT * FROM subscriptions WHERE stripe_subscription_id = ?",
    ).bind(event.stripeSubscriptionId).first<SubscriptionRow>();
    if (!subscription) throw new Error("Subscription event was not persisted");
    const applied = event.authoritative || subscription.last_event_created === event.eventCreated
      && subscription.last_event_id === event.eventId;
    const requested = applied ? await session.prepare(`
      SELECT 1 AS requested FROM provisioning_operations
      WHERE billing_account_id = ? AND updated_at = ?
        AND status IN ('pending', 'approved')
      LIMIT 1
    `).bind(event.billingAccountId, now).first<{ requested: number }>() : null;
    return {
      applied,
      provisioningRequested: requested?.requested === 1,
      subscription: subscriptionFromRow(subscription),
      residentId,
      operationId,
    };
  }

  async applyBillingReviewEvent(event: BillingReviewEvent) {
    for (const [name, value] of Object.entries({
      eventId: event.eventId,
      eventType: event.eventType,
      rawJson: event.rawJson,
      stripeObjectId: event.stripeObjectId,
      stripeObjectJson: event.stripeObjectJson,
      billingAccountId: event.billingAccountId,
      reason: event.reason,
    })) assertString(value, name);
    assertInteger(event.eventCreated, "eventCreated");
    const now = event.receivedAt ?? Date.now();
    assertInteger(now, "receivedAt");
    const residentId = `resident:${event.billingAccountId}`;
    const operationId = `billing-review:${event.billingAccountId}:${event.eventId}`;
    const session = this.db.withSession("first-primary");
    const results = await session.batch([
      session.prepare(`
        INSERT INTO stripe_events (
          id, event_type, event_created, object_id, raw_json, processing_status, received_at
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
        ON CONFLICT(id) DO NOTHING
      `).bind(event.eventId, event.eventType, event.eventCreated, event.stripeObjectId, event.rawJson, now),
      session.prepare(`
        INSERT INTO billing_review_holds (
          billing_account_id, reason, stripe_object_id, stripe_object_json,
          source_event_id, last_event_created, last_event_id, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (
          SELECT 1 FROM stripe_events WHERE id = ? AND processing_status = 'pending'
        )
        ON CONFLICT(billing_account_id) DO UPDATE SET
          reason = excluded.reason,
          stripe_object_id = excluded.stripe_object_id,
          stripe_object_json = excluded.stripe_object_json,
          source_event_id = excluded.source_event_id,
          last_event_created = excluded.last_event_created,
          last_event_id = excluded.last_event_id,
          updated_at = excluded.updated_at
        WHERE excluded.last_event_created > billing_review_holds.last_event_created
           OR (excluded.last_event_created = billing_review_holds.last_event_created
               AND excluded.last_event_id > billing_review_holds.last_event_id)
      `).bind(
        event.billingAccountId, event.reason, event.stripeObjectId, event.stripeObjectJson,
        event.eventId, event.eventCreated, event.eventId, now, now, event.eventId,
      ),
      session.prepare(`
        UPDATE billing_accounts SET authorization_state = 'suspended', updated_at = ?
        WHERE id = ? AND EXISTS (
          SELECT 1 FROM billing_review_holds
          WHERE billing_account_id = ? AND source_event_id = ?
        )
      `).bind(now, event.billingAccountId, event.billingAccountId, event.eventId),
      session.prepare(`
        UPDATE entitlements SET
          status = 'suspended', provision_enabled = 0, wake_enabled = 0,
          inference_enabled = 0, auditability_enabled = 0,
          source_event_id = ?, updated_at = ?
        WHERE billing_account_id = ? AND EXISTS (
          SELECT 1 FROM billing_review_holds
          WHERE billing_account_id = ? AND source_event_id = ?
        )
      `).bind(event.eventId, now, event.billingAccountId, event.billingAccountId, event.eventId),
      session.prepare(`
        INSERT INTO provisioning_operations (
          id, billing_account_id, resident_id, desired_revision, status,
          approval_state, approved_by, approved_at, approval_evidence_json,
          attempt_count, created_at, updated_at
        )
        SELECT ?, r.billing_account_id, r.id, ?, 'pending', 'approved', ?, ?, ?, 0, ?, ?
        FROM residents r
        JOIN billing_review_holds h ON h.billing_account_id = r.billing_account_id
        WHERE r.billing_account_id = ? AND h.source_event_id = ?
          AND r.desired_state <> 'suspended'
        ON CONFLICT(resident_id, desired_revision) DO NOTHING
      `).bind(
        operationId, `resident-state:suspended:${event.eventId}`,
        `stripe-billing-review:${event.eventId}`, now,
        JSON.stringify({ eventId: event.eventId, eventType: event.eventType, reason: event.reason }),
        now, now, event.billingAccountId, event.eventId,
      ),
      session.prepare(`
        UPDATE residents SET
          desired_state = 'suspended',
          pensieve_desired_state = CASE
            WHEN pensieve_desired_state = 'disabled' THEN 'disabled' ELSE 'suspended' END,
          suspended_at = ?, suspension_reason = ?, updated_at = ?
        WHERE billing_account_id = ? AND EXISTS (
          SELECT 1 FROM billing_review_holds
          WHERE billing_account_id = ? AND source_event_id = ?
        )
      `).bind(now, `billing-review:${event.reason}`, now,
        event.billingAccountId, event.billingAccountId, event.eventId),
      session.prepare(`
        UPDATE stripe_events SET
          processing_status = CASE WHEN EXISTS (
            SELECT 1 FROM billing_review_holds
            WHERE billing_account_id = ? AND source_event_id = ?
          ) THEN 'applied' ELSE 'ignored' END,
          processed_at = ?
        WHERE id = ? AND processing_status = 'pending'
      `).bind(event.billingAccountId, event.eventId, now, event.eventId),
    ]);
    const applied = Number(results.at(-1)?.meta.changes ?? 0) === 1
      && (await session.prepare(
        "SELECT processing_status FROM stripe_events WHERE id = ?",
      ).bind(event.eventId).first<{ processing_status: string }>())?.processing_status === "applied";
    const requested = applied ? await session.prepare(`
      SELECT 1 AS requested FROM provisioning_operations
      WHERE id = ? AND status IN ('pending', 'approved')
    `).bind(operationId).first<{ requested: number }>() : null;
    return { applied, provisioningRequested: requested?.requested === 1, residentId, operationId };
  }

  async getAccountStatus(billingAccountId: string): Promise<AccountBillingStatus | null> {
    const session = this.db.withSession("first-primary");
    const account = await session.prepare("SELECT * FROM billing_accounts WHERE id = ?")
      .bind(billingAccountId).first<BillingAccountRow>();
    if (!account) return null;
    const subscription = await session.prepare(`
        SELECT * FROM subscriptions WHERE billing_account_id = ?
        ORDER BY last_event_created DESC, last_event_id DESC LIMIT 1
      `).bind(billingAccountId).first<SubscriptionRow>();
    const resident = await session.prepare("SELECT * FROM residents WHERE billing_account_id = ?")
      .bind(billingAccountId).first<ResidentRow>();
    const entitlement = await session.prepare(`
        SELECT status, provision_enabled, wake_enabled, inference_enabled, auditability_enabled, paid_through
        FROM entitlements WHERE billing_account_id = ?
      `).bind(billingAccountId).first<{
        status: "active" | "suspended";
        provision_enabled: number;
        wake_enabled: number;
        inference_enabled: number;
        auditability_enabled: number;
        paid_through: number;
      }>();
    return {
      account: accountFromRow(account),
      subscription: subscription ? subscriptionFromRow(subscription) : null,
      resident: resident ? residentFromRow(resident) : null,
      entitlement: entitlement ? {
        status: entitlement.status,
        provisionEnabled: Boolean(entitlement.provision_enabled),
        wakeEnabled: Boolean(entitlement.wake_enabled),
        inferenceEnabled: Boolean(entitlement.inference_enabled),
        auditabilityEnabled: Boolean(entitlement.auditability_enabled),
        paidThrough: entitlement.paid_through,
      } : null,
    };
  }

  async recordProvisioningApproval(input: {
    operationId: string;
    approved: boolean;
    actor: string;
    now?: number;
  }) {
    assertString(input.operationId, "operationId");
    assertString(input.actor, "actor");
    const now = input.now ?? Date.now();
    assertInteger(now, "now");
    const result = await this.db.prepare(`
      UPDATE provisioning_operations SET
        approval_state = ?, approved_by = ?, approved_at = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND approval_state = 'required'
    `).bind(input.approved ? "approved" : "rejected", input.actor, now, now, input.operationId).run();
    return Number(result.meta.changes ?? 0) === 1;
  }

  async claimPendingProvisioningOperation(input: {
    workerId: string;
    githubAccountId: string;
    claimToken: string;
    claimExpiresAt: number;
    now?: number;
  }) {
    assertString(input.workerId, "workerId");
    assertString(input.githubAccountId, "githubAccountId");
    assertString(input.claimToken, "claimToken");
    const now = input.now ?? Date.now();
    assertInteger(now, "now");
    assertInteger(input.claimExpiresAt, "claimExpiresAt");
    if (input.claimExpiresAt <= now) throw new TypeError("claimExpiresAt must be in the future");
    const row = await this.db.prepare(`
      UPDATE provisioning_operations SET
        status = 'running', attempt_count = attempt_count + 1,
        claimed_by = ?, claim_token = ?, claim_expires_at = ?, updated_at = ?
      WHERE id = (
        SELECT p.id FROM provisioning_operations p
        JOIN billing_accounts a ON a.id = p.billing_account_id
        JOIN entitlements e ON e.billing_account_id = p.billing_account_id
        JOIN residents r ON r.id = p.resident_id
        WHERE p.approval_state = 'approved'
          AND a.github_account_id = ?
          AND ((r.desired_state = 'suspended'
              AND p.desired_revision LIKE 'resident-state:suspended:%')
            OR (r.desired_state <> 'suspended'
              AND p.desired_revision NOT LIKE 'resident-state:suspended:%'
              AND a.authorization_state = 'authorized'
              AND e.status = 'active' AND e.provision_enabled = 1))
          AND (
            p.status IN ('pending', 'approved')
            OR (p.status = 'running' AND p.claim_expires_at IS NOT NULL AND p.claim_expires_at <= ?)
          )
        ORDER BY p.created_at, p.id
        LIMIT 1
      )
      RETURNING *
    `).bind(
      input.workerId, input.claimToken, input.claimExpiresAt, now,
      input.githubAccountId, now,
    ).first<ProvisioningOperationRow>();
    return row ? provisioningOperationFromRow(row) : null;
  }

  async recordProvisioningResult(input: {
    operationId: string;
    workerId: string;
    claimToken: string;
    succeeded: boolean;
    evidenceJson: string;
    callbackIssuer: string;
    callbackSubject: string;
    githubAccountId: string;
    observedGeneration?: number;
    pinnedCatalogRevision?: string;
    agentResourceName?: string;
    desiredState?: "active" | "suspended";
    personaLogin?: string;
    pensieveProfile?: string;
    pensieveEvidenceJson?: string;
    error?: string;
    retryable?: boolean;
    now?: number;
  }) {
    for (const [name, value] of Object.entries({
      operationId: input.operationId,
      workerId: input.workerId,
      claimToken: input.claimToken,
      evidenceJson: input.evidenceJson,
      callbackIssuer: input.callbackIssuer,
      callbackSubject: input.callbackSubject,
      githubAccountId: input.githubAccountId,
    })) assertString(value, name);
    const now = input.now ?? Date.now();
    assertInteger(now, "now");
    if (input.succeeded) {
      if (input.observedGeneration === undefined) throw new TypeError("success requires observedGeneration");
      assertInteger(input.observedGeneration, "observedGeneration");
      if (!input.pinnedCatalogRevision) throw new TypeError("success requires pinnedCatalogRevision");
      if (!input.agentResourceName) throw new TypeError("success requires agentResourceName");
      if (input.desiredState !== "active" && input.desiredState !== "suspended") {
        throw new TypeError("success requires desiredState");
      }
      if (input.personaLogin !== undefined) validatePersonaLogin(input.personaLogin);
      if ((input.pensieveProfile === undefined) !== (input.pensieveEvidenceJson === undefined)) {
        throw new TypeError("Pensieve profile and evidence must be supplied together");
      }
      if (input.pensieveProfile !== undefined) assertString(input.pensieveProfile, "pensieveProfile");
      if (input.pensieveEvidenceJson !== undefined) assertString(input.pensieveEvidenceJson, "pensieveEvidenceJson");
    } else if (!input.error?.trim()) {
      throw new TypeError("failure requires an error");
    }
    if (!input.succeeded && input.personaLogin !== undefined) {
      throw new TypeError("personaLogin is only valid for a successful provisioning result");
    }
    const session = this.db.withSession("first-primary");
    const auditability = await session.prepare(`
      SELECT r.pensieve_profile, e.auditability_enabled
      FROM provisioning_operations p
      JOIN residents r ON r.id = p.resident_id
      JOIN entitlements e ON e.billing_account_id = p.billing_account_id
      WHERE p.id = ? AND p.status = 'running' AND p.claimed_by = ? AND p.claim_token = ?
        AND p.claim_expires_at > ?
      LIMIT 1
    `).bind(input.operationId, input.workerId, input.claimToken, now).first<{
      pensieve_profile: string | null;
      auditability_enabled: number;
    }>();
    if (input.succeeded && auditability?.auditability_enabled === 1
      && (input.pensieveProfile !== auditability.pensieve_profile || !input.pensieveEvidenceJson)) {
      throw new TypeError("success requires evidence for the entitled Pensieve profile");
    }
    const results = await session.batch([
      session.prepare(`
        UPDATE provisioning_operations SET
          status = CASE
            WHEN ? THEN 'succeeded'
            WHEN ? AND attempt_count < 3 THEN 'pending'
            ELSE 'failed'
          END,
          evidence_json = ?, deployment_callback_issuer = ?,
          deployment_callback_subject = ?, completed_at = ?, last_error = ?,
          claimed_by = NULL, claim_token = NULL, claim_expires_at = NULL, updated_at = ?
        WHERE id = ? AND status = 'running' AND claimed_by = ? AND claim_token = ?
          AND claim_expires_at > ?
          AND billing_account_id IN (
            SELECT id FROM billing_accounts WHERE github_account_id = ?
          )
          AND (? = 0 OR resident_id IN (
            SELECT id FROM residents
            WHERE agent_resource_name = ?
              AND CASE WHEN desired_state = 'suspended' THEN 'suspended' ELSE 'active' END = ?
          ))
      `).bind(
        input.succeeded ? 1 : 0, input.retryable === true ? 1 : 0, input.evidenceJson,
        input.callbackIssuer, input.callbackSubject, now, input.error ?? null,
        now, input.operationId, input.workerId, input.claimToken, now,
        input.githubAccountId, input.succeeded ? 1 : 0,
        input.agentResourceName ?? "", input.desiredState ?? "",
      ),
      session.prepare(`
        UPDATE residents SET
          observed_state = CASE
            WHEN (SELECT status FROM provisioning_operations WHERE id = ?) = 'failed' THEN 'error'
            WHEN desired_state = 'suspended' THEN 'suspended'
            ELSE 'ready'
          END,
          desired_state = CASE
            WHEN (SELECT status FROM provisioning_operations WHERE id = ?) = 'failed' THEN desired_state
            WHEN desired_state = 'suspended' THEN 'suspended'
            ELSE 'active'
          END,
          observed_generation = ?,
          pinned_catalog_revision = ?, ready_evidence_json = ?,
          persona_login = COALESCE(?, persona_login),
          pensieve_observed_state = CASE
            WHEN (SELECT status FROM provisioning_operations WHERE id = ?) = 'failed' THEN 'error'
            WHEN pensieve_desired_state = 'disabled' THEN 'disabled'
            WHEN ? = pensieve_profile AND ? IS NOT NULL THEN 'ready'
            ELSE 'non-conforming'
          END,
          pensieve_evidence_json = CASE
            WHEN ? = pensieve_profile THEN ? ELSE pensieve_evidence_json
          END,
          updated_at = ?
        WHERE id = (
          SELECT resident_id FROM provisioning_operations
          WHERE id = ? AND completed_at = ? AND status IN ('succeeded', 'failed')
        )
      `).bind(
        input.operationId, input.operationId,
        input.observedGeneration ?? null, input.pinnedCatalogRevision ?? null,
        input.evidenceJson, input.succeeded ? input.personaLogin ?? null : null,
        input.operationId, input.pensieveProfile ?? null, input.pensieveEvidenceJson ?? null,
        input.pensieveProfile ?? null, input.pensieveEvidenceJson ?? null,
        now, input.operationId, now,
      ),
    ]);
    return Number(results[0]?.meta.changes ?? 0) === 1;
  }

  async hasActiveResidentEntitlement(
    billingAccountId: string,
    residentId: string,
    capability: "wake" | "inference",
  ) {
    const column = capability === "wake" ? "wake_enabled" : "inference_enabled";
    const row = await this.db.prepare(`
      SELECT 1 AS allowed
      FROM entitlements e
      JOIN residents r ON r.billing_account_id = e.billing_account_id
      JOIN billing_accounts b ON b.id = e.billing_account_id
      WHERE e.billing_account_id = ? AND r.id = ? AND e.status = 'active'
        AND b.authorization_state = 'authorized'
        AND e.${column} = 1 AND r.desired_state = 'active' AND r.observed_state = 'ready'
      LIMIT 1
    `).bind(billingAccountId, residentId).first<{ allowed: number }>();
    return row?.allowed === 1;
  }

  async preflightInference(residentId: string, atUnixSeconds = Math.floor(Date.now() / 1000)):
    Promise<InferenceAuthorization> {
    assertString(residentId, "residentId");
    assertInteger(atUnixSeconds, "atUnixSeconds");
    const row = await this.db.prepare(`
      SELECT
        a.id AS billing_account_id, r.id AS resident_id, a.markup_basis_points,
        a.accepted_rate_card_version, a.hard_spend_limit_micros,
        s.current_period_start, s.current_period_end,
        a.authorization_state, e.status AS entitlement_status, e.inference_enabled,
        r.desired_state, r.observed_state, s.status AS subscription_status,
        COALESCE((
          SELECT SUM(u.provider_cost_micros + u.markup_micros)
          FROM inference_usage_events u
          WHERE u.billing_account_id = a.id
            AND u.occurred_at >= s.current_period_start
            AND u.occurred_at < s.current_period_end
        ), 0) AS period_spend_micros
      FROM residents r
      JOIN billing_accounts a ON a.id = r.billing_account_id
      JOIN entitlements e ON e.billing_account_id = a.id
      JOIN subscriptions s ON s.stripe_subscription_id = e.stripe_subscription_id
      WHERE r.id = ? AND s.current_period_start <= ? AND s.current_period_end > ?
      ORDER BY s.last_event_created DESC, s.last_event_id DESC
      LIMIT 1
    `).bind(residentId, atUnixSeconds, atUnixSeconds).first<InferenceAuthorizationRow>();
    if (!row) return { authorized: false, reason: "not_entitled", residentId };
    const policy = usagePolicyFromRow(row);
    const cap = spendLimitState(row.hard_spend_limit_micros, row.period_spend_micros);
    const entitled = row.authorization_state === "authorized"
      && row.entitlement_status === "active"
      && row.inference_enabled === 1
      && row.desired_state === "active"
      && row.observed_state === "ready"
      && row.subscription_status === "active";
    return {
      ...policy,
      authorized: entitled && !cap.reached,
      reason: cap.reached ? "spend_limit_reached" : !entitled ? "not_entitled" : "authorized",
      periodSpendMicros: row.period_spend_micros,
      remainingHardSpendLimitMicros: cap.remainingMicros,
    };
  }

  async ingestInferenceUsage(input: InferenceUsage) {
    this.validateUsage(input);
    const recordedAt = input.recordedAt ?? Date.now();
    assertInteger(recordedAt, "recordedAt");
    const session = this.db.withSession("first-primary");
    const existing = await session.prepare(`
      SELECT * FROM inference_usage_events WHERE resident_id = ? AND request_id = ?
    `).bind(input.residentId, input.requestId).first<UsageRow>();
    if (existing) {
      const canonical = usageFromRow(existing);
      resolveUsageDedupe(canonical, input);
      return { inserted: false, usage: canonical };
    }
    const policyRow = await session.prepare(`
      SELECT
        a.id AS billing_account_id, r.id AS resident_id, a.markup_basis_points,
        a.accepted_rate_card_version, a.hard_spend_limit_micros,
        s.current_period_start, s.current_period_end
      FROM residents r
      JOIN billing_accounts a ON a.id = r.billing_account_id
      JOIN subscriptions s ON s.billing_account_id = a.id
      WHERE r.id = ? AND a.id = ?
        AND s.current_period_start <= ? AND s.current_period_end > ?
      ORDER BY s.last_event_created DESC, s.last_event_id DESC
      LIMIT 1
    `).bind(
      input.residentId, input.billingAccountId, input.occurredAt, input.occurredAt,
    ).first<UsageBillingPolicyRow>();
    if (!policyRow) throw new Error("Usage tenant, resident, or subscription period is invalid");
    const policy = usagePolicyFromRow(policyRow);
    validateUsageBillingPolicy(policy, input);
    const results = await session.batch([
      session.prepare(`
        INSERT INTO inference_usage_events (
          id, billing_account_id, resident_id, request_id, request_body_digest, provider, model,
          input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          rate_card_version, provider_cost_micros, markup_basis_points, markup_micros,
          occurred_at, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT DO NOTHING
      `).bind(
        input.id, input.billingAccountId, input.residentId, input.requestId,
        input.requestBodyDigest, input.provider, input.model, input.inputTokens, input.outputTokens,
        input.cacheReadTokens, input.cacheWriteTokens, input.rateCardVersion,
        input.providerCostMicros, input.markupBasisPoints, input.markupMicros,
        input.occurredAt, recordedAt,
      ),
      ...(["provider_cost", "markup"] as const).map((meterKind) => session.prepare(`
        INSERT INTO meter_exports (
          usage_event_id, meter_kind, status, attempt_count, created_at, updated_at
        )
        SELECT id, ?, 'pending', 0, ?, ? FROM inference_usage_events
        WHERE resident_id = ? AND request_id = ?
        ON CONFLICT(usage_event_id, meter_kind) DO NOTHING
      `).bind(meterKind, recordedAt, recordedAt, input.residentId, input.requestId)),
      session.prepare(`
        UPDATE entitlements SET inference_enabled = 0, updated_at = ?
        WHERE billing_account_id = ?
          AND (SELECT hard_spend_limit_micros FROM billing_accounts WHERE id = ?) IS NOT NULL
          AND (
            SELECT COALESCE(SUM(provider_cost_micros + markup_micros), 0)
            FROM inference_usage_events
            WHERE billing_account_id = ? AND occurred_at >= ? AND occurred_at < ?
          ) >= (SELECT hard_spend_limit_micros FROM billing_accounts WHERE id = ?)
      `).bind(
        recordedAt, policy.billingAccountId, policy.billingAccountId, policy.billingAccountId,
        policy.currentPeriodStart, policy.currentPeriodEnd, policy.billingAccountId,
      ),
    ]);
    const row = await session.prepare(`
      SELECT * FROM inference_usage_events WHERE resident_id = ? AND request_id = ?
    `).bind(input.residentId, input.requestId).first<UsageRow>();
    if (!row) throw new Error("Usage event was not persisted");
    const canonical = usageFromRow(row);
    resolveUsageDedupe(canonical, input);
    return { inserted: Number(results[0]?.meta.changes ?? 0) === 1, usage: canonical };
  }

  async listPendingMeterExports(now = Date.now(), limit = 100): Promise<PendingMeterExport[]> {
    assertInteger(now, "now");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
      throw new TypeError("limit must be an integer between 1 and 1000");
    }
    const result = await this.db.prepare(`
      SELECT m.usage_event_id, m.meter_kind, m.stripe_meter_event_id, m.status,
        m.attempt_count, m.last_error, m.next_attempt_at, m.exported_at,
        m.first_attempt_at, m.last_attempt_at, m.retry_deadline_at,
        m.delivery_state, m.reconciliation_state,
        a.stripe_customer_id, u.occurred_at, u.provider_cost_micros, u.markup_micros
      FROM meter_exports m
      JOIN inference_usage_events u ON u.id = m.usage_event_id
      JOIN billing_accounts a ON a.id = u.billing_account_id
      WHERE m.status IN ('pending', 'failed')
        AND m.reconciliation_state = 'automatic'
        AND (m.retry_deadline_at IS NULL OR m.retry_deadline_at > ?)
        AND (m.next_attempt_at IS NULL OR m.next_attempt_at <= ?)
      ORDER BY COALESCE(m.next_attempt_at, 0), m.created_at
      LIMIT ?
    `).bind(now, now, limit).all<PendingMeterExportRow>();
    return result.results.map(pendingMeterExportFromRow);
  }

  async expireAmbiguousMeterExports(now = Date.now()) {
    assertInteger(now, "now");
    const result = await this.db.prepare(`
      UPDATE meter_exports SET
        reconciliation_state = 'manual_reconciliation',
        next_attempt_at = NULL,
        last_error = COALESCE(last_error, 'Stripe delivery remained ambiguous beyond the automatic retry window'),
        updated_at = ?
      WHERE reconciliation_state = 'automatic'
        AND status IN ('pending', 'failed')
        AND delivery_state = 'ambiguous'
        AND retry_deadline_at IS NOT NULL
        AND retry_deadline_at <= ?
    `).bind(now, now).run();
    return Number(result.meta.changes ?? 0);
  }

  async beginMeterExportAttempt(input: {
    usageEventId: string;
    meterKind: MeterKind;
    retryDeadlineAt: number;
    now?: number;
  }) {
    const now = input.now ?? Date.now();
    assertInteger(now, "now");
    assertInteger(input.retryDeadlineAt, "retryDeadlineAt");
    if (input.retryDeadlineAt <= now) throw new TypeError("retryDeadlineAt must be in the future");
    const result = await this.db.prepare(`
      UPDATE meter_exports SET
        attempt_count = attempt_count + 1,
        first_attempt_at = COALESCE(first_attempt_at, ?),
        last_attempt_at = ?,
        retry_deadline_at = COALESCE(retry_deadline_at, ?),
        delivery_state = 'ambiguous',
        updated_at = ?
      WHERE usage_event_id = ? AND meter_kind = ?
        AND status IN ('pending', 'failed')
        AND reconciliation_state = 'automatic'
        AND (retry_deadline_at IS NULL OR retry_deadline_at > ?)
    `).bind(
      now, now, input.retryDeadlineAt, now,
      input.usageEventId, input.meterKind, now,
    ).run();
    return Number(result.meta.changes ?? 0) === 1;
  }

  async recordMeterExportResult(input: {
    usageEventId: string;
    meterKind: MeterKind;
    stripeMeterEventId?: string;
    error?: string;
    retryAt?: number;
    manualReconciliation?: boolean;
    deliveryState?: Exclude<MeterDeliveryState, "not_attempted">;
    now?: number;
  }) {
    const now = input.now ?? Date.now();
    assertInteger(now, "now");
    if (input.stripeMeterEventId && input.error) {
      throw new TypeError("A meter export result cannot be both exported and failed");
    }
    if (!input.stripeMeterEventId && !input.error) {
      throw new TypeError("A meter export result requires an event ID or error");
    }
    if (input.retryAt !== undefined) assertInteger(input.retryAt, "retryAt");
    if (input.stripeMeterEventId && input.manualReconciliation) {
      throw new TypeError("An exported meter event cannot require manual reconciliation");
    }
    if (input.manualReconciliation && input.retryAt !== undefined) {
      throw new TypeError("Manual reconciliation cannot have an automatic retry time");
    }
    await this.db.prepare(`
      UPDATE meter_exports SET
        stripe_meter_event_id = ?,
        status = ?,
        last_error = ?,
        next_attempt_at = ?,
        exported_at = ?,
        delivery_state = ?,
        reconciliation_state = ?,
        updated_at = ?
      WHERE usage_event_id = ? AND meter_kind = ?
    `).bind(
      input.stripeMeterEventId ?? null,
      input.stripeMeterEventId ? "exported" : "failed",
      input.error ?? null,
      input.stripeMeterEventId ? null : input.retryAt ?? null,
      input.stripeMeterEventId ? now : null,
      input.stripeMeterEventId ? "confirmed" : input.deliveryState ?? "ambiguous",
      input.manualReconciliation ? "manual_reconciliation" : "automatic",
      now,
      input.usageEventId,
      input.meterKind,
    ).run();
  }

  private validateSubscriptionEvent(event: SubscriptionLifecycleEvent) {
    for (const [name, value] of Object.entries({
      eventId: event.eventId,
      eventType: event.eventType,
      rawJson: event.rawJson,
      stripeObjectJson: event.stripeObjectJson,
      billingAccountId: event.billingAccountId,
      stripeSubscriptionId: event.stripeSubscriptionId,
      stripeSubscriptionItemId: event.stripeSubscriptionItemId,
      agentResourceName: event.agentResourceName,
    })) assertString(value, name);
    for (const [name, value] of Object.entries({
      eventCreated: event.eventCreated,
      currentPeriodStart: event.currentPeriodStart,
      currentPeriodEnd: event.currentPeriodEnd,
    })) assertInteger(value, name);
    if (event.currentPeriodEnd < event.currentPeriodStart) {
      throw new TypeError("currentPeriodEnd must not precede currentPeriodStart");
    }
    if (event.reconciledAt !== undefined && event.reconciledAt !== null) {
      assertInteger(event.reconciledAt, "reconciledAt");
    }
    if (event.authoritative && event.reconciledAt === undefined) {
      throw new TypeError("authoritative Stripe state requires reconciledAt");
    }
    if (event.auditabilityEnabled) {
      if (!event.auditabilityStripeItemId || !event.pensieveProfile) {
        throw new TypeError("auditability requires a Stripe item and Pensieve profile");
      }
      assertString(event.auditabilityStripeItemId, "auditabilityStripeItemId");
      assertString(event.pensieveProfile, "pensieveProfile");
    } else if (event.auditabilityStripeItemId !== null || event.pensieveProfile !== null) {
      throw new TypeError("disabled auditability must not carry a Stripe item or Pensieve profile");
    }
    if (event.residentQuantity !== 1) throw new TypeError("residentQuantity must be 1");
  }

  private validateUsage(input: InferenceUsage) {
    for (const [name, value] of Object.entries({
      id: input.id,
      billingAccountId: input.billingAccountId,
      residentId: input.residentId,
      requestId: input.requestId,
      requestBodyDigest: input.requestBodyDigest,
      provider: input.provider,
      model: input.model,
      rateCardVersion: input.rateCardVersion,
    })) assertString(value, name);
    for (const [name, value] of Object.entries({
      inputTokens: input.inputTokens,
      outputTokens: input.outputTokens,
      cacheReadTokens: input.cacheReadTokens,
      cacheWriteTokens: input.cacheWriteTokens,
      providerCostMicros: input.providerCostMicros,
      markupBasisPoints: input.markupBasisPoints,
      markupMicros: input.markupMicros,
      occurredAt: input.occurredAt,
    })) assertInteger(value, name);
  }
}

ALTER TABLE provisioning_operations ADD COLUMN completion_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS provisioning_operations_completion_token_idx
  ON provisioning_operations (completion_token)
  WHERE completion_token IS NOT NULL;

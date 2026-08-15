BEGIN;

-- Bearer links authenticate possession. Keep only their one-way hashes after
-- creation/rotation; a database/application read must not be enough to recover
-- every still-live customer claim or invitation URL.
ALTER TABLE customer_account_claims
    ALTER COLUMN token_encrypted DROP NOT NULL;
ALTER TABLE customer_invitations
    ALTER COLUMN token_encrypted DROP NOT NULL;

-- Existing issued URLs continue to work because redemption already validates
-- token_hash. Remove the recoverable ciphertext without revoking those links.
UPDATE customer_account_claims SET token_encrypted=NULL WHERE token_encrypted IS NOT NULL;
UPDATE customer_invitations SET token_encrypted=NULL WHERE token_encrypted IS NOT NULL;

COMMIT;

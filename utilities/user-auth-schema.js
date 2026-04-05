const query = require('../db/db');

let userAuthSchemaReadyPromise = null;

async function ensureUserAuthSchema() {
  if (!userAuthSchemaReadyPromise) {
    userAuthSchemaReadyPromise = ensureUserAuthSchemaInternal().catch((error) => {
      userAuthSchemaReadyPromise = null;
      throw error;
    });
  }

  await userAuthSchemaReadyPromise;
}

async function ensureUserAuthSchemaInternal() {
  await query(`
    ALTER TABLE user_account
      ADD COLUMN IF NOT EXISTS is_email_verified boolean NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS email_verification_token_hash varchar(128),
      ADD COLUMN IF NOT EXISTS email_verification_token_expires_at timestamp,
      ADD COLUMN IF NOT EXISTS email_verification_last_sent_at timestamp,
      ADD COLUMN IF NOT EXISTS email_verification_sent_window_started_at timestamp,
      ADD COLUMN IF NOT EXISTS email_verification_sent_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS password_reset_token_hash varchar(128),
      ADD COLUMN IF NOT EXISTS password_reset_token_expires_at timestamp
  `);

  await query(`
    UPDATE user_account
    SET is_email_verified = TRUE
    WHERE google_id IS NOT NULL
      AND COALESCE(is_email_verified, FALSE) = FALSE
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS user_account_email_verification_token_hash_idx
    ON user_account (email_verification_token_hash)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS user_account_password_reset_token_hash_idx
    ON user_account (password_reset_token_hash)
  `);
}

module.exports = {
  ensureUserAuthSchema
};

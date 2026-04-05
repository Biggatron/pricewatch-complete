const query = require('../db/db');
const { ensureTrackSoftDeleteColumn } = require('./track-soft-delete');

let trackUniqueIndexReadyPromise = null;

async function ensureTrackUniqueActiveIndex() {
  if (!trackUniqueIndexReadyPromise) {
    trackUniqueIndexReadyPromise = ensureTrackUniqueActiveIndexInternal().catch((error) => {
      trackUniqueIndexReadyPromise = null;
      throw error;
    });
  }

  await trackUniqueIndexReadyPromise;
}

async function ensureTrackUniqueActiveIndexInternal() {
  await ensureTrackSoftDeleteColumn();

  await query(`
    WITH ranked_tracks AS (
      SELECT
        id,
        ROW_NUMBER() OVER (
          PARTITION BY user_id, price_url
          ORDER BY COALESCE(last_modified_at, created_at) DESC NULLS LAST, id DESC
        ) AS row_number
      FROM track
      WHERE deleted = FALSE
        AND user_id IS NOT NULL
        AND price_url IS NOT NULL
    )
    UPDATE track
    SET deleted = TRUE,
        active = FALSE,
        last_modified_at = COALESCE(last_modified_at, NOW())
    WHERE id IN (
      SELECT id
      FROM ranked_tracks
      WHERE row_number > 1
    )
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS track_user_id_price_url_active_unique_idx
    ON track (user_id, price_url)
    WHERE deleted = FALSE
      AND user_id IS NOT NULL
  `);
}

module.exports = {
  ensureTrackUniqueActiveIndex
};

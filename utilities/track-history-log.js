const query = require('../db/db');

let tableReadyPromise = null;

async function ensureTrackHistoryTable() {
  if (!tableReadyPromise) {
    tableReadyPromise = ensureTable().catch((error) => {
      tableReadyPromise = null;
      throw error;
    });
  }

  await tableReadyPromise;
}

async function ensureTable() {
  await query(`
    CREATE TABLE IF NOT EXISTS track_change_history (
      "id" serial PRIMARY KEY,
      "track_id" integer NOT NULL,
      "price_before" numeric,
      "price_after" numeric,
      "active" boolean,
      "changed_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  await query(`
    ALTER TABLE track_change_history
      ADD COLUMN IF NOT EXISTS track_id integer,
      ADD COLUMN IF NOT EXISTS price_before numeric,
      ADD COLUMN IF NOT EXISTS price_after numeric,
      ADD COLUMN IF NOT EXISTS active boolean,
      ADD COLUMN IF NOT EXISTS changed_at timestamp NOT NULL DEFAULT now()
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS track_change_history_track_id_changed_at_idx
    ON track_change_history (track_id, changed_at DESC, id DESC)
  `);
}

async function insertTrackHistoryEntry(entry) {
  await ensureTrackHistoryTable();
  const result = await query(
    `INSERT INTO track_change_history (
      track_id,
      price_before,
      price_after,
      active,
      changed_at
    ) VALUES ($1, $2, $3, $4, $5)
    RETURNING *`,
    [
      entry.trackId,
      entry.priceBefore != null ? entry.priceBefore : null,
      entry.priceAfter != null ? entry.priceAfter : null,
      typeof entry.active === 'boolean' ? entry.active : null,
      entry.changedAt || new Date()
    ]
  );

  return result.rows[0] || null;
}

async function getTrackHistoryMap(trackIds, options = {}) {
  await ensureTrackHistoryTable();

  const normalizedTrackIds = Array.from(new Set(
    (trackIds || [])
      .map((trackId) => Number(trackId))
      .filter((trackId) => Number.isInteger(trackId))
  ));

  const historyMap = new Map();
  for (const trackId of normalizedTrackIds) {
    historyMap.set(trackId, []);
  }

  if (normalizedTrackIds.length === 0) {
    return historyMap;
  }

  await backfillMissingTrackHistory(normalizedTrackIds);

  const limitPerTrack = Number.isInteger(options.limitPerTrack) && options.limitPerTrack > 0
    ? options.limitPerTrack
    : 25;

  const result = await query(
    `SELECT *
     FROM (
       SELECT
         track_change_history.*,
         ROW_NUMBER() OVER (
           PARTITION BY track_id
           ORDER BY changed_at DESC, id DESC
         ) AS row_num
       FROM track_change_history
       WHERE track_id = ANY($1::int[])
     ) ranked_history
     WHERE row_num <= $2
     ORDER BY track_id ASC, changed_at DESC, id DESC`,
    [normalizedTrackIds, limitPerTrack]
  );

  for (const row of result.rows) {
    if (!historyMap.has(row.track_id)) {
      historyMap.set(row.track_id, []);
    }

    historyMap.get(row.track_id).push(row);
  }

  return historyMap;
}

async function backfillMissingTrackHistory(trackIds) {
  const result = await query(
    `SELECT
       track.id,
       track.curr_price,
       track.active,
       COALESCE(track.last_modified_at, track.created_at, now()) AS baseline_changed_at
     FROM track
     LEFT JOIN track_change_history
       ON track_change_history.track_id = track.id
     WHERE track.id = ANY($1::int[])
     GROUP BY track.id, track.curr_price, track.active, track.last_modified_at, track.created_at
     HAVING COUNT(track_change_history.id) = 0`,
    [trackIds]
  );

  for (const row of result.rows) {
    await insertTrackHistoryEntry({
      trackId: row.id,
      priceBefore: null,
      priceAfter: row.curr_price,
      active: typeof row.active === 'boolean' ? row.active : null,
      changedAt: row.baseline_changed_at || new Date()
    });
  }
}

module.exports = {
  ensureTrackHistoryTable,
  insertTrackHistoryEntry,
  getTrackHistoryMap
};

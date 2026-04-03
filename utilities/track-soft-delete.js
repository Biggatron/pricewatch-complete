const query = require('../db/db');

let trackSoftDeleteReadyPromise = null;

async function ensureTrackSoftDeleteColumn() {
  if (!trackSoftDeleteReadyPromise) {
    trackSoftDeleteReadyPromise = ensureColumn().catch((error) => {
      trackSoftDeleteReadyPromise = null;
      throw error;
    });
  }

  await trackSoftDeleteReadyPromise;
}

async function ensureColumn() {
  await query(`
    ALTER TABLE track
    ADD COLUMN IF NOT EXISTS deleted boolean NOT NULL DEFAULT FALSE
  `);
}

module.exports = {
  ensureTrackSoftDeleteColumn
};

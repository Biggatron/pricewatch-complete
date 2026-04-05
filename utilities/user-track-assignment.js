const query = require('../db/db');

async function attachGuestTracksToUserByEmail({ userId, email }) {
  const normalizedEmail = String(email || '').trim().toLowerCase();
  if (!userId || !normalizedEmail) {
    return {
      attachedTrackCount: 0
    };
  }

  const result = await query(
    `UPDATE track
     SET user_id = $1,
         email = $2,
         last_modified_at = $3
     WHERE user_id IS NULL
       AND LOWER(COALESCE(email, '')) = $4
     RETURNING id`,
    [userId, normalizedEmail, new Date(), normalizedEmail]
  );

  return {
    attachedTrackCount: result.rowCount || 0
  };
}

module.exports = {
  attachGuestTracksToUserByEmail
};

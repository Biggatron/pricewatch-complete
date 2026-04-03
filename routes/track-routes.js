const router = require('express').Router();
const crawler = require('../utilities/crawler');
const query = require('../db/db');
const keys = require('../config/keys');
const { getTrackHistoryMap, insertTrackHistoryEntry } = require('../utilities/track-history-log');
const { buildTrackHistoryGraphModel } = require('../utilities/track-history-graph');
const { ensureTrackSoftDeleteColumn } = require('../utilities/track-soft-delete');

const authCheck = (req, res, next) => {
  if (!req.user) {
    res.redirect('/auth/login');
  } else {
    next();
  }
};

const adminCheck = (req, res, next) => {
  const userEmail = ((req.user && req.user.email) || '').toLowerCase();
  if (!keys.admin.allowedEmails.includes(userEmail)) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  next();
};

const apiAuthCheck = (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Login required' });
  }

  next();
};

// New track landing page
router.get('/', (req, res) => {
  res.render('new-track', { user: req.user });
});

// New track landing page
router.get('/tracklist', authCheck, async (req, res, next) => {
  try {
    await getTracks(req.user, res);
  } catch (error) {
    next(error);
  }
});

router.post('/preview', async (req, res) => {
  const inputUrl = String((req.body && req.body.url) || '').trim();
  if (!inputUrl) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    const preview = await crawler.getUrlPreview(inputUrl);
    res.status(200).json(preview);
  } catch (error) {
    const statusCode = error && error.code === 'INVALID_PREVIEW_URL' ? 400 : 500;
    console.error('[track] Failed to build preview', {
      url: inputUrl,
      error
    });
    res.status(statusCode).json({
      error: error && error.message ? error.message : 'Failed to load preview'
    });
  }
});

router.post('/', async (req, res, next) => {
  console.log('New track posted in background...');

  const priceUrl = String((req.body && req.body.url) || '').trim();
  const originalPrice = crawler.extractNumber(String((req.body && req.body.price) || ''));
  const email = String((req.body && req.body.email) || (req.user && req.user.email) || '').trim();

  if (!priceUrl) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!originalPrice) {
    return res.status(400).json({ error: 'Price is required and must contain digits' });
  }

  if (!email) {
    return res.status(400).json({ error: 'Email is required' });
  }

  const trackRequest = {
    price_url: priceUrl,
    orig_price: originalPrice,
    email,
    user_id: req.user ? req.user.id : null
  };

  try {
    await crawler.findAndSavePrices(trackRequest, false, res);
  } catch (error) {
    next(error);
  }
});

router.post('/update-prices', authCheck, adminCheck, (req, res) => {
  console.log('Updating prices in background...');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.status(200).send('Track update job started');
  crawler.updatePrices({
    triggerType: 'manual',
    triggeredBy: req.user
  });
});

router.delete('/:id', apiAuthCheck, async (req, res, next) => {
  try {
    await deleteTrack(req, res);
  } catch (error) {
    next(error);
  }
});

async function getTracks(user, res) {
  await ensureTrackSoftDeleteColumn();

  console.info('[track] Loading tracks for user', { userId: user.id });
  const result = await query(
    `SELECT *
     FROM track
     WHERE user_id = $1
       AND deleted = FALSE
     ORDER BY last_modified_at DESC, id DESC`,
    [user.id]
  );
  const historyMap = await getTrackHistoryMap(result.rows.map((track) => track.id));
  const tracksWithHistory = result.rows.map((track) => ({
    ...track,
    historyEntries: historyMap.get(track.id) || [],
    historyGraph: buildTrackHistoryGraphModel(track, historyMap.get(track.id) || [])
  }));
  console.info('[track] Tracks loaded', {
    userId: user.id,
    trackCount: tracksWithHistory.length
  });
  res.render('my-tracks', { user, tracks: tracksWithHistory });
}

async function deleteTrack(req, res) {
  await ensureTrackSoftDeleteColumn();

  const trackId = Number(req.params.id);
  const user = req.user;

  if (!Number.isInteger(trackId)) {
    return res.status(400).json({ error: 'Invalid track id' });
  }

  const getTrackResult = await query(
    `SELECT *
     FROM track
     WHERE id = $1
       AND deleted = FALSE`,
    [trackId]
  );
  const track = getTrackResult.rows[0];

  if (!track) {
    return res.status(404).json({ error: `Track ${trackId} does not exist` });
  }

  if (track.user_id !== user.id) {
    console.warn('[track] User tried to delete track owned by another user', {
      actingUserId: user.id,
      trackId,
      ownerUserId: track.user_id
    });
    return res.status(403).json({ error: 'You can only delete your own tracks' });
  }

  const deletedAt = new Date();
  const deleteTrackResult = await query(
    `UPDATE track
     SET deleted = TRUE,
         active = FALSE,
         last_modified_at = $1
     WHERE id = $2
       AND user_id = $3
       AND deleted = FALSE
     RETURNING *`,
    [deletedAt, trackId, user.id]
  );

  const deletedTrack = deleteTrackResult.rows[0];
  if (!deletedTrack) {
    return res.status(404).json({ error: `Failed to delete track ${trackId}` });
  }

  if (Boolean(track.active)) {
    await insertTrackHistoryEntry({
      trackId,
      priceBefore: track.curr_price,
      priceAfter: track.curr_price,
      active: false,
      changedAt: deletedAt
    });
  }

  console.info('[track] Track soft deleted', {
    userId: user.id,
    trackId
  });

  return res.status(200).json({
    message: 'Track deleted',
    trackId
  });
}

module.exports = router;

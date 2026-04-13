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
  if (!req.user) {
    return res.render('landing', { user: req.user });
  }

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
  if (!req.user) {
    return res.status(401).json({ error: 'Login or sign up to preview tracked products.' });
  }

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

router.post('/lookup', async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Login required' });
  }

  const inputUrl = String((req.body && req.body.url) || '').trim();
  if (!inputUrl) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    await ensureTrackSoftDeleteColumn();
    const lookup = await lookupTrackByUrl(req.user, inputUrl);

    if (lookup.sameUserTrack) {
      return res.status(200).json({
        sameUserTrack: true,
        otherUserTrack: false,
        ...lookup.sameUserTrack
      });
    }

    if (lookup.otherUserTrack) {
      return res.status(200).json({
        sameUserTrack: false,
        otherUserTrack: true,
        ...lookup.otherUserTrack
      });
    }

    return res.status(200).json({
      sameUserTrack: false,
      otherUserTrack: false,
      currentPrice: null,
      productName: null
    });
  } catch (error) {
    next(error);
  }
});

router.post('/detect', async (req, res, next) => {
  if (!req.user) {
    return res.status(401).json({ error: 'Login required' });
  }

  const inputUrl = String((req.body && req.body.url) || '').trim();
  if (!inputUrl) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    await ensureTrackSoftDeleteColumn();
    const lookup = await lookupTrackByUrl(req.user, inputUrl);

    if (lookup.sameUserTrack) {
      return res.status(200).json({
        sameUserTrack: true,
        otherUserTrack: false,
        selectorFound: false,
        ...lookup.sameUserTrack
      });
    }

    if (lookup.otherUserTrack) {
      return res.status(200).json({
        sameUserTrack: false,
        otherUserTrack: true,
        selectorFound: true,
        detectionSource: 'existing_track',
        currentPrice: lookup.otherUserTrack.currentPrice,
        currentPriceDisplay: lookup.otherUserTrack.currentPrice,
        productName: lookup.otherUserTrack.productName || null
      });
    }

    const detection = await crawler.detectTrackByUrl({
      price_url: inputUrl,
      email: String((req.user && req.user.email) || '').trim(),
      user_id: req.user ? req.user.id : null
    });

    if (!detection || !detection.success || !detection.track) {
      return res.status(200).json({
        sameUserTrack: false,
        otherUserTrack: false,
        selectorFound: false,
        detectionSource: detection && detection.reason ? detection.reason : 'none'
      });
    }

    return res.status(200).json({
      sameUserTrack: false,
      otherUserTrack: false,
      selectorFound: true,
      detectionSource: detection.selector && detection.selector.selector_type
        ? detection.selector.selector_type
        : 'domain_selector',
      currentPrice: detection.track.curr_price,
      currentPriceDisplay: detection.track.display_price_text || detection.track.curr_price,
      productName: detection.track.product_name || null
    });
  } catch (error) {
    next(error);
  }
});

router.post('/', async (req, res, next) => {
  console.log('New track posted in background...');

  if (!req.user) {
    return res.status(401).json({
      error: 'Login or sign up to start tracking prices.'
    });
  }

  const priceUrl = String((req.body && req.body.url) || '').trim();
  const originalPrice = crawler.extractNumber(String((req.body && req.body.price) || ''));
  const email = String((req.user && req.user.email) || '').trim();

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

router.post('/:id/reactivate', apiAuthCheck, async (req, res, next) => {
  try {
    await reactivateTrack(req, res);
  } catch (error) {
    next(error);
  }
});

router.post('/:id/reactivate/reset', apiAuthCheck, async (req, res, next) => {
  try {
    await resetTrackReactivation(req, res);
  } catch (error) {
    next(error);
  }
});

async function lookupTrackByUrl(user, inputUrl) {
  const sameUserResult = await query(
    `SELECT id, curr_price, product_name
     FROM track
     WHERE user_id = $1
       AND price_url = $2
       AND deleted = FALSE
     ORDER BY last_modified_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [user.id, inputUrl]
  );

  if (sameUserResult.rows[0]) {
    return {
      sameUserTrack: {
        trackId: sameUserResult.rows[0].id,
        currentPrice: sameUserResult.rows[0].curr_price,
        productName: sameUserResult.rows[0].product_name || null,
        message: 'You are already tracking this product',
        code: 'TRACK_EXISTS'
      },
      otherUserTrack: null
    };
  }

  const otherUserResult = await query(
    `SELECT id, curr_price, product_name
     FROM track
     WHERE price_url = $1
       AND deleted = FALSE
     ORDER BY last_modified_at DESC NULLS LAST, id DESC
     LIMIT 1`,
    [inputUrl]
  );

  return {
    sameUserTrack: null,
    otherUserTrack: otherUserResult.rows[0]
      ? {
        trackId: otherUserResult.rows[0].id,
        currentPrice: otherUserResult.rows[0].curr_price,
        productName: otherUserResult.rows[0].product_name || null
      }
      : null
  };
}

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

async function reactivateTrack(req, res) {
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
    console.warn('[track] User tried to reactivate track owned by another user', {
      actingUserId: user.id,
      trackId,
      ownerUserId: track.user_id
    });
    return res.status(403).json({ error: 'You can only reactivate your own tracks' });
  }

  if (Boolean(track.active)) {
    return res.status(409).json({ error: 'Track is already active' });
  }

  const result = await crawler.updateSingleTrack(track, {
    triggerType: 'manual-reactivate',
    triggeredBy: req.user
  });
  const itemResult = result.itemResult || {};
  const successStatuses = new Set([
    'reactivated',
    'updated_lower',
    'updated_higher',
    'updated_other'
  ]);

  if (!successStatuses.has(itemResult.status)) {
    return res.status(422).json({
      error: itemResult.errorMessage || 'Could not reactivate this track',
      allowPriceReset: true,
      runId: result.runId,
      result: itemResult
    });
  }

  return res.status(200).json({
    message: 'Track reactivated',
    trackId,
    runId: result.runId,
    result: itemResult
  });
}

async function resetTrackReactivation(req, res) {
  await ensureTrackSoftDeleteColumn();

  const trackId = Number(req.params.id);
  const user = req.user;
  const rawPriceInput = String((req.body && req.body.price) || '').trim();
  const currentPrice = crawler.extractNumber(rawPriceInput);

  if (!Number.isInteger(trackId)) {
    return res.status(400).json({ error: 'Invalid track id' });
  }

  if (!currentPrice) {
    return res.status(400).json({ error: 'Current price is required' });
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
    console.warn('[track] User tried to reset reactivation for track owned by another user', {
      actingUserId: user.id,
      trackId,
      ownerUserId: track.user_id
    });
    return res.status(403).json({ error: 'You can only reactivate your own tracks' });
  }

  if (Boolean(track.active)) {
    return res.status(409).json({ error: 'Track is already active' });
  }

  const result = await crawler.resetInactiveTrackWithCurrentPrice(track, currentPrice);

  if (!result.success) {
    return res.status(result.code === 'INVALID_PRICE' ? 400 : 422).json({
      error: result.error || 'Could not reactivate this track',
      allowPriceReset: true
    });
  }

  return res.status(200).json({
    message: 'Track reactivated with updated price location',
    trackId,
    result
  });
}

module.exports = router;

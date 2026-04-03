const router = require('express').Router();
const crawler = require('../utilities/crawler');
const query = require('../db/db');
const keys = require('../config/keys');
const { getTrackHistoryMap } = require('../utilities/track-history-log');
const { buildTrackHistoryGraphModel } = require('../utilities/track-history-graph');

const authCheck = (req, res, next) => {
    if(!req.user){
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

// New track landing page
router.get('/', (req, res) => {
  res.render('new-track', { user: req.user });
});

// New track landing page
router.get('/tracklist', authCheck, (req, res) => {
  getTracks(req.user, res);
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
    console.log("New track posted in background...")

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
    console.log("Updating prices in background...")
    res.setHeader('Access-Control-Allow-Origin', '*')
    res.status(200).send('Track update job started');
    crawler.updatePrices({
      triggerType: 'manual',
      triggeredBy: req.user
    });
  });
  
  router.delete('/*', (req, res) => {
    console.log('delete track route hit')
    deleteTrack(res, req);
  });

  async function checkIfTrackExists( trackRequest, res) {
    console.log(`Getting track with url ${trackRequest.price_url } and for user: ${trackRequest.user_id}`)
    const result = await query(
      `SELECT * FROM track WHERE user_id = ${user.id} and price_url = ${trackRequest.price_url} ORDER BY created_at DESC`
    );
    let track = result.rows[0];
    if (track) {
      if (track.active) {
        res.status(404).json({error: `You are already tracking this price`})
        return;
      } else {
        trackRequest.action = 'update';
      }
    } 
    return trackRequest;
  }

  async function getTracks(user, res) {
    console.info('[track] Loading tracks for user', { userId: user.id });
    const result = await query(
      `SELECT * FROM track WHERE user_id = ${user.id} ORDER BY last_modified_at DESC`
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
    res.render('my-tracks', { user: user, tracks: tracksWithHistory });
  }

  async function deleteTrack(res, req) {
    let trackId = req.params[0];
    let user = req.user;
    
    const getTrackResult = await query(
        `SELECT * FROM track WHERE id = '${trackId}'`
    );
    let track = getTrackResult.rows[0];
    if (!track) {
        res.status(404).json({error: `Track ${trackId} does not exist`})
        return;
    }
    if (!user) {
        res.status(404).json({error: `User has to be logged on to delete track`})
        return;
    }
    if (track.user_id === user.id) {
        // Delete track
        const deleteTrackResult = await query(
            `DELETE FROM track WHERE id = '${trackId}'`
        );
        console.log({
            deleteTrackResult: deleteTrackResult
        })
        const getDeleteTrackResult = await query(
            `SELECT * FROM track WHERE id = '${trackId}'`
        );
        let track = getDeleteTrackResult.rows[0];
        if (track) {
            res.sendStatus(404).json({error: `Failed to delete track ${trackId}`})
            return;
        } else {
            res.sendStatus(200);
            return;
        }
    } else {
        res.status(404).json({error: 'user.id does not match track.user_id'})
        console.log(`user ${user.id} tried to delete track owned by ${track.user_id}`)
    }
}

module.exports = router;

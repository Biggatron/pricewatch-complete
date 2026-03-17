const router = require('express').Router();
const keys = require('../config/keys');
const query = require('../db/db');
const { readRecentLogs, getLogFilePath } = require('../utilities/logger');
const {
  getRecentCrawlerFailureLogs,
  getCrawlerFailureLogById
} = require('../utilities/crawler-failure-log');
const {
  getRecentCrawlerRuns,
  getCrawlerRunById,
  getCrawlerRunItems
} = require('../utilities/crawler-run-log');

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
    return res.status(403).render('admin', {
      user: req.user,
      logs: [],
      logFilePath: getLogFilePath(),
      accessDenied: true
    });
  }
  next();
};

router.get('/', authCheck, adminCheck, async (req, res, next) => {
  try {
    const [logs, failedUpdates, recentRuns, tracks] = await Promise.all([
      readRecentLogs(),
      getRecentCrawlerFailureLogs(),
      getRecentCrawlerRuns(),
      getAllTracksForAdmin()
    ]);

    res.render('admin', {
      user: req.user,
      logs,
      failedUpdates,
      recentRuns,
      latestRun: recentRuns[0] || null,
      tracks,
      logFilePath: getLogFilePath(),
      accessDenied: false
    });
  } catch (error) {
    next(error);
  }
});

router.post('/tracks/:id', authCheck, adminCheck, async (req, res, next) => {
  try {
    const trackId = Number(req.params.id);
    const origPrice = Number(req.body.orig_price);
    const currPrice = Number(req.body.curr_price);
    const active = Boolean(req.body.active);

    if (!Number.isInteger(trackId)) {
      return res.status(400).json({ error: 'Invalid track id' });
    }

    if (!Number.isFinite(origPrice) || !Number.isFinite(currPrice)) {
      return res.status(400).json({ error: 'Original price and current price must be valid numbers' });
    }

    const result = await query(
      `UPDATE track
       SET orig_price = $1,
           curr_price = $2,
           active = $3,
           last_modified_at = $4
       WHERE id = $5
       RETURNING *`,
      [origPrice, currPrice, active, new Date(), trackId]
    );

    if (!result.rows[0]) {
      return res.status(404).json({ error: 'Track not found' });
    }

    console.info('[admin] Track updated', {
      adminUserId: req.user.id,
      adminEmail: req.user.email,
      trackId,
      origPrice,
      currPrice,
      active
    });

    res.status(200).json({
      message: 'Track updated',
      track: result.rows[0]
    });
  } catch (error) {
    next(error);
  }
});

router.get('/failed-updates/:id', authCheck, adminCheck, async (req, res, next) => {
  try {
    const failure = await getCrawlerFailureLogById(req.params.id);
    if (!failure) {
      return res.status(404).send('Failed update log not found');
    }

    res.render('admin-failure-detail', {
      user: req.user,
      failure
    });
  } catch (error) {
    next(error);
  }
});

router.get('/runs/:id', authCheck, adminCheck, async (req, res, next) => {
  try {
    const [run, items] = await Promise.all([
      getCrawlerRunById(req.params.id),
      getCrawlerRunItems(req.params.id)
    ]);

    if (!run) {
      return res.status(404).send('Crawler run not found');
    }

    res.render('admin-run-detail', {
      user: req.user,
      run,
      items
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;

async function getAllTracksForAdmin() {
  const result = await query(
    `SELECT
       track.id,
       track.orig_price,
       track.curr_price,
       track.active,
       track.price_url,
       track.product_name,
       track.user_id,
       track.email,
       track.last_modified_at,
       user_account.name AS user_name
     FROM track
     LEFT JOIN user_account ON user_account.id = track.user_id
     ORDER BY track.last_modified_at DESC, track.id DESC`
  );

  return result.rows;
}

const router = require('express').Router();
const keys = require('../config/keys');
const query = require('../db/db');
const crawler = require('../utilities/crawler');
const { readRecentLogs, getLogFilePath } = require('../utilities/logger');
const {
  getAllAppConfig,
  getAppConfigRow,
  setAppConfig
} = require('../utilities/app-config');
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
      accessDenied: true,
      failedUpdates: [],
      recentRuns: [],
      latestRun: null,
      tracks: [],
      appConfigs: [],
      recentFailedTrackLogs: [],
      recentEmailLogs: []
    });
  }
  next();
};

router.get('/', authCheck, adminCheck, async (req, res, next) => {
  try {
    const [logs, failedUpdates, recentRuns, tracks, appConfigs, recentFailedTrackLogs, recentEmailLogs] = await Promise.all([
      readRecentLogs(),
      getRecentCrawlerFailureLogs(),
      getRecentCrawlerRuns(),
      getAllTracksForAdmin(),
      getAllAppConfig(),
      getRecentFailedTrackLogs(),
      getRecentEmailLogs()
    ]);

    res.render('admin', {
      user: req.user,
      logs,
      failedUpdates,
      recentRuns,
      latestRun: recentRuns[0] || null,
      tracks,
      appConfigs,
      recentFailedTrackLogs,
      recentEmailLogs,
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

router.post('/tracks/:id/update-now', authCheck, adminCheck, async (req, res, next) => {
  try {
    const track = await getTrackById(req.params.id);
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const result = await crawler.updateSingleTrack(track, {
      triggerType: 'manual-single',
      triggeredBy: req.user
    });

    res.status(200).json({
      message: 'Track update completed',
      runId: result.runId,
      result: result.itemResult
    });
  } catch (error) {
    next(error);
  }
});

router.post('/config', authCheck, adminCheck, async (req, res, next) => {
  try {
    const configKey = String(req.body.config_key || '').trim();
    if (!configKey) {
      return res.status(400).json({ error: 'Config key is required' });
    }

    const existingConfig = await getAppConfigRow(configKey);
    if (!existingConfig) {
      return res.status(404).json({ error: 'Config entry not found' });
    }

    const normalizedValue = normalizeConfigValue(req.body.value, existingConfig.data_type);
    if (normalizedValue == null) {
      return res.status(400).json({ error: `Invalid value for ${existingConfig.data_type}` });
    }

    const updatedConfig = await setAppConfig({
      key: existingConfig.config_key,
      category: existingConfig.category,
      value: normalizedValue,
      dataType: existingConfig.data_type,
      description: existingConfig.description,
      valueHelp: existingConfig.value_help
    });

    console.info('[admin] App config updated', {
      adminUserId: req.user.id,
      adminEmail: req.user.email,
      configKey,
      value: normalizedValue
    });

    res.status(200).json({
      message: 'Config updated',
      config: updatedConfig
    });
  } catch (error) {
    next(error);
  }
});

router.get('/tracks/:id/html', authCheck, adminCheck, async (req, res, next) => {
  try {
    const track = await getTrackById(req.params.id);
    if (!track) {
      return res.status(404).json({ error: 'Track not found' });
    }

    const html = await crawler.getTrackHtmlPreview(track);
    res.status(200).json({
      trackId: track.id,
      productName: track.product_name,
      url: track.price_url,
      html
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

async function getTrackById(trackId) {
  const result = await query(
    `SELECT
       track.*,
       user_account.name AS user_name
     FROM track
     LEFT JOIN user_account ON user_account.id = track.user_id
     WHERE track.id = $1`,
    [trackId]
  );

  return result.rows[0] || null;
}

async function getRecentFailedTrackLogs(limit = 1000) {
  const result = await query(
    `SELECT *
     FROM failed_track_logs
     ORDER BY created_at DESC, id DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows;
}

async function getRecentEmailLogs(limit = 1000) {
  const result = await query(
    `SELECT *
     FROM email_logs
     ORDER BY created_at DESC, id DESC
     LIMIT $1`,
    [limit]
  );

  return result.rows;
}

function normalizeConfigValue(value, dataType) {
  if (dataType === 'boolean') {
    if (value === true || value === 'true' || value === 'on' || value === '1' || value === 1) {
      return 'true';
    }

    if (value === false || value === 'false' || value === 'off' || value === '0' || value === 0 || value == null) {
      return 'false';
    }

    return null;
  }

  if (dataType === 'integer') {
    const parsed = Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? String(parsed) : null;
  }

  if (dataType === 'number') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? String(parsed) : null;
  }

  if (dataType === 'json') {
    try {
      JSON.parse(String(value));
      return String(value);
    } catch (error) {
      return null;
    }
  }

  return value == null ? '' : String(value);
}

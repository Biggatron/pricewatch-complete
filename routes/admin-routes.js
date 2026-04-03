const router = require('express').Router();
const keys = require('../config/keys');
const query = require('../db/db');
const crawler = require('../utilities/crawler');
const { readRecentLogs, getLogFilePath, clearLogFile } = require('../utilities/logger');
const {
  getAllAppConfig,
  getAppConfigRow,
  setAppConfig
} = require('../utilities/app-config');
const { isValidCronExpression } = require('../utilities/cron-util');
const { JOB_DEFINITIONS, getJobDefinition } = require('../utilities/job-definitions');
const { runJob, startJob } = require('../utilities/job-runner');
const { getJobScheduleSummaries } = require('../utilities/job-schedule-log');
const { getTrackHistoryMap, insertTrackHistoryEntry } = require('../utilities/track-history-log');
const { buildTrackHistoryGraphModel } = require('../utilities/track-history-graph');
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
      jobSettings: [],
      jobScheduleSummaries: [],
      previewCacheSummary: {
        screenshotDirectory: '',
        screenshotFiles: []
      },
      recentFailedTrackLogs: [],
      recentEmailLogs: [],
      activeTab: getActiveAdminTab(req.query.tab)
    });
  }
  next();
};

router.get('/', authCheck, adminCheck, async (req, res, next) => {
  try {
    const activeTab = getActiveAdminTab(req.query.tab);
    const trackFilters = getTrackAdminFilters(req.query);
    const failedTrackFilters = getFailedTrackLogFilters(req.query);
    const emailFilters = getEmailLogFilters(req.query);

    const [logs, failedUpdates, recentRuns, tracks, appConfigs, recentFailedTrackLogs, recentEmailLogs, jobScheduleSummaries] = await Promise.all([
      readRecentLogs(),
      getRecentCrawlerFailureLogs(),
      getRecentCrawlerRuns(),
      getAllTracksForAdmin(trackFilters),
      getAllAppConfig(),
      getRecentFailedTrackLogs(failedTrackFilters),
      getRecentEmailLogs(emailFilters),
      getJobScheduleSummaries()
    ]);
    const previewCacheSummary = await crawler.getPreviewCacheSummary();

    const trackHistoryMap = await getTrackHistoryMap(tracks.map((track) => track.id));
    const tracksWithHistory = tracks.map((track) => ({
      ...track,
      historyEntries: trackHistoryMap.get(track.id) || [],
      historyGraph: buildTrackHistoryGraphModel(track, trackHistoryMap.get(track.id) || [])
    }));

    res.render('admin', {
      user: req.user,
      logs,
      failedUpdates,
      recentRuns,
      latestRun: recentRuns[0] || null,
      tracks: tracksWithHistory,
      appConfigs,
      jobSettings: buildJobSettings(appConfigs),
      jobScheduleSummaries,
      previewCacheSummary,
      recentFailedTrackLogs,
      recentEmailLogs,
      trackFilters,
      failedTrackFilters,
      emailFilters,
      activeTab,
      logFilePath: getLogFilePath(),
      accessDenied: false
    });
  } catch (error) {
    next(error);
  }
});

router.post('/jobs/:jobKey/run', authCheck, adminCheck, async (req, res, next) => {
  try {
    const jobKey = String(req.params.jobKey || '').trim();
    const job = getJobDefinition(jobKey);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }

    const result = await startJob(jobKey, {
      triggerType: 'manual',
      triggeredBy: req.user,
      ignoreSchedule: jobKey === 'email_delivery'
    });

    if (result.status === 'locked') {
      return res.status(409).json({
        error: `${job.displayName} is already running`
      });
    }

    console.info('[admin] Job executed manually', {
      adminUserId: req.user.id,
      adminEmail: req.user.email,
      jobKey,
      resultStatus: result.status
    });

    res.status(202).json({
      message: `${job.displayName} job started`,
      result
    });
  } catch (error) {
    next(error);
  }
});

router.post('/logs/clear', authCheck, adminCheck, async (req, res, next) => {
  try {
    await clearLogFile();
    console.info('[admin] Log file cleared', {
      adminUserId: req.user.id,
      adminEmail: req.user.email
    });
    res.status(200).json({ message: 'Log file cleared' });
  } catch (error) {
    next(error);
  }
});

router.post('/emails/send-pending', authCheck, adminCheck, async (req, res, next) => {
  try {
    const jobResult = await runJob('email_delivery', {
      triggerType: 'manual',
      triggeredBy: req.user,
      ignoreSchedule: true
    });

    if (jobResult.status === 'locked') {
      return res.status(409).json({ error: 'Email delivery is already running' });
    }

    const summary = jobResult.summary || {};
    console.info('[admin] Pending emails processed', {
      adminUserId: req.user.id,
      adminEmail: req.user.email,
      ...summary
    });
    res.status(200).json({
      message: 'Pending emails processed',
      summary
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

    const existingTrackResult = await query(
      `SELECT *
       FROM track
       WHERE id = $1`,
      [trackId]
    );
    const existingTrack = existingTrackResult.rows[0];

    if (!existingTrack) {
      return res.status(404).json({ error: 'Track not found' });
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

    if (
      Number(existingTrack.curr_price) !== currPrice ||
      Boolean(existingTrack.active) !== active
    ) {
      await insertTrackHistoryEntry({
        trackId,
        priceBefore: existingTrack.curr_price,
        priceAfter: currPrice,
        active
      });
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

    if (isCronConfigKey(configKey) && !isValidCronExpression(req.body.value)) {
      return res.status(400).json({ error: 'Invalid cron expression. Expected 5 fields like */5 * * * *' });
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

async function getAllTracksForAdmin(filters = getTrackAdminFilters()) {
  const conditions = [];
  const params = [];

  if (filters.search) {
    params.push(buildLikePattern(filters.search));
    const patternParam = `$${params.length}`;
    conditions.push(`(
      track.product_name ILIKE ${patternParam} ESCAPE '\\'
      OR track.price_url ILIKE ${patternParam} ESCAPE '\\'
      OR COALESCE(track.email, '') ILIKE ${patternParam} ESCAPE '\\'
      OR COALESCE(user_account.name, '') ILIKE ${patternParam} ESCAPE '\\'
    )`);
  }

  if (filters.active === 'active' || filters.active === 'inactive') {
    params.push(filters.active === 'active');
    conditions.push(`track.active = $${params.length}`);
  }

  params.push(filters.maxRows);
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
     ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY ${getTrackSortClause(filters.sort)}
     LIMIT $${params.length}`,
    params
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

async function getRecentFailedTrackLogs(filters = getFailedTrackLogFilters()) {
  const conditions = [];
  const params = [];

  if (filters.search) {
    params.push(buildLikePattern(filters.search));
    const patternParam = `$${params.length}`;
    conditions.push(`(
      COALESCE(domain, '') ILIKE ${patternParam} ESCAPE '\\'
      OR COALESCE(product_url, '') ILIKE ${patternParam} ESCAPE '\\'
      OR COALESCE(product_price, '') ILIKE ${patternParam} ESCAPE '\\'
    )`);
  }

  params.push(filters.maxRows);
  const result = await query(
    `SELECT *
     FROM failed_track_logs
     ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY ${getFailedTrackSortClause(filters.sort)}
     LIMIT $${params.length}`,
    params
  );

  return result.rows;
}

async function getRecentEmailLogs(filters = getEmailLogFilters()) {
  const conditions = [];
  const params = [];
  const effectiveStatusExpression = `COALESCE(status, CASE WHEN delivered THEN 'sent' ELSE 'pending' END)`;

  if (filters.search) {
    params.push(buildLikePattern(filters.search));
    const patternParam = `$${params.length}`;
    conditions.push(`(
      COALESCE(product_name, '') ILIKE ${patternParam} ESCAPE '\\'
      OR COALESCE(email, '') ILIKE ${patternParam} ESCAPE '\\'
      OR COALESCE(subject, '') ILIKE ${patternParam} ESCAPE '\\'
      OR COALESCE(error_message, '') ILIKE ${patternParam} ESCAPE '\\'
    )`);
  }

  if (filters.status !== 'all') {
    params.push(filters.status);
    conditions.push(`${effectiveStatusExpression} = $${params.length}`);
  }

  if (filters.emailType !== 'all') {
    params.push(filters.emailType);
    conditions.push(`email_type = $${params.length}`);
  }

  params.push(filters.maxRows);
  const result = await query(
    `SELECT
       *,
       ${effectiveStatusExpression} AS effective_status
     FROM email_logs
     ${conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : ''}
     ORDER BY ${getEmailSortClause(filters.sort, effectiveStatusExpression)}
     LIMIT $${params.length}`,
    params
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

function getActiveAdminTab(tab) {
  const allowedTabs = new Set([
    'overview',
    'jobs',
    'tracks',
    'config',
    'cache',
    'service-logs',
    'failed-tracks',
    'emails'
  ]);
  return allowedTabs.has(tab) ? tab : 'overview';
}

function getTrackAdminFilters(queryParams = {}) {
  return {
    search: String(queryParams.track_search || '').trim(),
    active: normalizeSelectValue(queryParams.track_active, ['all', 'active', 'inactive'], 'all'),
    sort: normalizeSelectValue(
      queryParams.track_sort,
      ['modified_desc', 'modified_asc', 'product_asc', 'product_desc', 'curr_price_desc', 'curr_price_asc', 'user_asc', 'user_desc'],
      'modified_desc'
    ),
    maxRows: parseMaxRows(queryParams.track_max_rows, 50)
  };
}

function getFailedTrackLogFilters(queryParams = {}) {
  return {
    search: String(queryParams.failed_search || '').trim(),
    sort: normalizeSelectValue(
      queryParams.failed_sort,
      ['created_desc', 'created_asc', 'domain_asc', 'domain_desc', 'price_desc', 'price_asc'],
      'created_desc'
    ),
    maxRows: parseMaxRows(queryParams.failed_max_rows, 50)
  };
}

function getEmailLogFilters(queryParams = {}) {
  return {
    search: String(queryParams.email_search || '').trim(),
    status: normalizeSelectValue(
      queryParams.email_status,
      ['all', 'pending', 'sent', 'undeliverable', 'skipped_disabled', 'skipped_missing_config'],
      'all'
    ),
    emailType: normalizeSelectValue(
      queryParams.email_type,
      ['all', 'price_change', 'track_inactive', 'generic'],
      'all'
    ),
    sort: normalizeSelectValue(
      queryParams.email_sort,
      ['created_desc', 'created_asc', 'status_asc', 'status_desc', 'attempts_desc', 'attempts_asc', 'email_asc', 'email_desc'],
      'created_desc'
    ),
    maxRows: parseMaxRows(queryParams.email_max_rows, 50)
  };
}

function parseMaxRows(value, fallbackValue) {
  const parsed = Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(parsed)) {
    return fallbackValue;
  }

  return Math.min(Math.max(parsed, 1), 500);
}

function normalizeSelectValue(value, allowedValues, fallbackValue) {
  const normalizedValue = String(value || '').trim().toLowerCase();
  return allowedValues.includes(normalizedValue) ? normalizedValue : fallbackValue;
}

function buildLikePattern(value) {
  return `%${String(value).replace(/[\\%_]/g, '\\$&')}%`;
}

function getTrackSortClause(sort) {
  const trackSortMap = {
    modified_desc: 'track.last_modified_at DESC NULLS LAST, track.id DESC',
    modified_asc: 'track.last_modified_at ASC NULLS LAST, track.id ASC',
    product_asc: 'track.product_name ASC NULLS LAST, track.id DESC',
    product_desc: 'track.product_name DESC NULLS LAST, track.id DESC',
    curr_price_desc: 'track.curr_price DESC NULLS LAST, track.id DESC',
    curr_price_asc: 'track.curr_price ASC NULLS LAST, track.id DESC',
    user_asc: 'user_account.name ASC NULLS LAST, track.id DESC',
    user_desc: 'user_account.name DESC NULLS LAST, track.id DESC'
  };

  return trackSortMap[sort] || trackSortMap.modified_desc;
}

function getFailedTrackSortClause(sort) {
  const failedTrackSortMap = {
    created_desc: 'created_at DESC NULLS LAST, id DESC',
    created_asc: 'created_at ASC NULLS LAST, id ASC',
    domain_asc: 'domain ASC NULLS LAST, id DESC',
    domain_desc: 'domain DESC NULLS LAST, id DESC',
    price_desc: 'product_price DESC NULLS LAST, id DESC',
    price_asc: 'product_price ASC NULLS LAST, id DESC'
  };

  return failedTrackSortMap[sort] || failedTrackSortMap.created_desc;
}

function getEmailSortClause(sort, effectiveStatusExpression = 'status') {
  const emailSortMap = {
    created_desc: 'created_at DESC NULLS LAST, id DESC',
    created_asc: 'created_at ASC NULLS LAST, id ASC',
    status_asc: `${effectiveStatusExpression} ASC NULLS LAST, id DESC`,
    status_desc: `${effectiveStatusExpression} DESC NULLS LAST, id DESC`,
    attempts_desc: 'attempt_count DESC NULLS LAST, id DESC',
    attempts_asc: 'attempt_count ASC NULLS LAST, id DESC',
    email_asc: 'email ASC NULLS LAST, id DESC',
    email_desc: 'email DESC NULLS LAST, id DESC'
  };

  return emailSortMap[sort] || emailSortMap.created_desc;
}

function isCronConfigKey(configKey) {
  return JOB_DEFINITIONS.some((job) => job.cronConfigKey === configKey);
}

function buildJobSettings(appConfigs) {
  const configMap = new Map(appConfigs.map((config) => [config.config_key, config]));

  return JOB_DEFINITIONS.map((job) => {
    const enabledConfig = configMap.get(job.enabledConfigKey);
    const cronConfig = configMap.get(job.cronConfigKey);

    return {
      key: job.key,
      displayName: job.displayName,
      description: job.description,
      enabled: enabledConfig ? Boolean(enabledConfig.parsed_value) : job.defaultEnabled,
      cronExpression: cronConfig && cronConfig.value ? cronConfig.value : job.defaultCron
    };
  });
}

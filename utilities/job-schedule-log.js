const query = require('../db/db');
const { ensureAppConfigTable, getAppConfig } = require('./app-config');
const { JOB_DEFINITIONS } = require('./job-definitions');
const {
  isValidCronExpression,
  getCurrentOrNextCronOccurrence,
  getNextCronOccurrence
} = require('./cron-util');

let tableReadyPromise = null;

async function ensureJobScheduleTable() {
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
    CREATE TABLE IF NOT EXISTS scheduled_job_runs (
      "id" serial PRIMARY KEY,
      "job_key" varchar(64) NOT NULL,
      "job_name" varchar(128) NOT NULL,
      "cron_expression" text,
      "status" varchar(32) NOT NULL DEFAULT 'pending',
      "run_after_time" timestamp NOT NULL,
      "actual_run_time" timestamp,
      "error_reason" text,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  await query(`
    ALTER TABLE scheduled_job_runs
      ADD COLUMN IF NOT EXISTS job_key varchar(64),
      ADD COLUMN IF NOT EXISTS job_name varchar(128),
      ADD COLUMN IF NOT EXISTS cron_expression text,
      ADD COLUMN IF NOT EXISTS status varchar(32) NOT NULL DEFAULT 'pending',
      ADD COLUMN IF NOT EXISTS run_after_time timestamp,
      ADD COLUMN IF NOT EXISTS actual_run_time timestamp,
      ADD COLUMN IF NOT EXISTS error_reason text,
      ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now()
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS scheduled_job_runs_job_key_idx
    ON scheduled_job_runs (job_key, run_after_time DESC, id DESC)
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS scheduled_job_runs_pending_job_key_idx
    ON scheduled_job_runs (job_key)
    WHERE status = 'pending'
  `);
}

async function syncPendingScheduledJobRuns(referenceTime = new Date()) {
  await ensureJobScheduleTable();
  await ensureAppConfigTable();

  const currentPendingRows = await getPendingScheduledJobRuns();
  const pendingByJobKey = new Map(currentPendingRows.map((row) => [row.job_key, row]));
  const syncedStateByJobKey = new Map();

  for (const job of JOB_DEFINITIONS) {
    const enabled = await getAppConfig(job.enabledConfigKey, job.defaultEnabled);
    const cronExpression = String(await getAppConfig(job.cronConfigKey, job.defaultCron) || '').trim();
    const scheduleValid = enabled ? isValidCronExpression(cronExpression) : true;
    let pendingRun = pendingByJobKey.get(job.key) || null;
    let scheduleError = null;

    if (!enabled) {
      if (pendingRun) {
        await cancelPendingScheduledJobRun(pendingRun.id, 'Job disabled');
        pendingRun = null;
      }
    } else if (!scheduleValid) {
      scheduleError = 'Invalid cron expression';
      if (pendingRun) {
        await cancelPendingScheduledJobRun(pendingRun.id, scheduleError);
        pendingRun = null;
      }
    } else {
      const runAfterTime = getCurrentOrNextCronOccurrence(cronExpression, referenceTime);
      if (!pendingRun) {
        pendingRun = await insertPendingScheduledJobRun(job, cronExpression, runAfterTime);
      } else if (
        pendingRun.job_name !== job.displayName ||
        pendingRun.cron_expression !== cronExpression
      ) {
        pendingRun = await updatePendingScheduledJobRun(pendingRun.id, job, cronExpression, runAfterTime);
      }
    }

    syncedStateByJobKey.set(job.key, {
      jobKey: job.key,
      displayName: job.displayName,
      enabled: Boolean(enabled),
      cronExpression,
      scheduleValid,
      scheduleError,
      pendingRun
    });
  }

  return syncedStateByJobKey;
}

async function markScheduledJobRunStarted(runId, actualRunTime = new Date()) {
  await ensureJobScheduleTable();
  const result = await query(
    `UPDATE scheduled_job_runs
     SET status = 'running',
         actual_run_time = $2,
         error_reason = NULL,
         updated_at = $3
     WHERE id = $1
     RETURNING *`,
    [runId, actualRunTime, new Date()]
  );

  return result.rows[0] || null;
}

async function finalizeScheduledJobRun(runId, { status, errorReason = null }) {
  await ensureJobScheduleTable();
  const result = await query(
    `UPDATE scheduled_job_runs
     SET status = $2,
         error_reason = $3,
         updated_at = $4
     WHERE id = $1
     RETURNING *`,
    [runId, status, errorReason, new Date()]
  );

  return result.rows[0] || null;
}

async function createNextPendingScheduledJobRun(job, cronExpression, referenceTime = new Date()) {
  await ensureJobScheduleTable();
  const nextRunAt = getNextCronOccurrence(cronExpression, referenceTime);
  return insertPendingScheduledJobRun(job, cronExpression, nextRunAt);
}

async function getJobScheduleSummaries(referenceTime = new Date()) {
  await ensureJobScheduleTable();
  const stateByJobKey = await syncPendingScheduledJobRuns(referenceTime);
  const lastCompletedRows = await getLatestScheduledJobRuns();
  const lastRunByJobKey = new Map(lastCompletedRows.map((row) => [row.job_key, row]));

  return JOB_DEFINITIONS.map((job) => {
    const state = stateByJobKey.get(job.key) || {};
    const lastRun = lastRunByJobKey.get(job.key) || null;

    return {
      key: job.key,
      displayName: job.displayName,
      description: job.description,
      enabled: Boolean(state.enabled),
      cronExpression: state.cronExpression || job.defaultCron,
      scheduleValid: state.scheduleValid !== false,
      scheduleError: state.scheduleError || null,
      nextRunAt: state.pendingRun ? state.pendingRun.run_after_time : null,
      lastRunAt: lastRun ? lastRun.actual_run_time : null,
      lastStatus: lastRun ? lastRun.status : null,
      lastErrorReason: lastRun ? lastRun.error_reason : null
    };
  });
}

async function getPendingScheduledJobRuns() {
  await ensureJobScheduleTable();
  const result = await query(
    `SELECT *
     FROM scheduled_job_runs
     WHERE status = 'pending'
     ORDER BY run_after_time ASC, id ASC`
  );

  return result.rows;
}

async function getLatestScheduledJobRuns() {
  await ensureJobScheduleTable();
  const result = await query(
    `SELECT DISTINCT ON (job_key) *
     FROM scheduled_job_runs
     WHERE status <> 'pending'
       AND actual_run_time IS NOT NULL
     ORDER BY job_key ASC, actual_run_time DESC, id DESC`
  );

  return result.rows;
}

async function insertPendingScheduledJobRun(job, cronExpression, runAfterTime) {
  await ensureJobScheduleTable();

  try {
    const result = await query(
      `INSERT INTO scheduled_job_runs (
        job_key,
        job_name,
        cron_expression,
        status,
        run_after_time,
        actual_run_time,
        error_reason,
        created_at,
        updated_at
      ) VALUES ($1, $2, $3, 'pending', $4, NULL, NULL, $5, $6)
      RETURNING *`,
      [job.key, job.displayName, cronExpression, runAfterTime, new Date(), new Date()]
    );

    return result.rows[0] || null;
  } catch (error) {
    if (error && error.code === '23505') {
      return getPendingScheduledJobRun(job.key);
    }

    throw error;
  }
}

async function updatePendingScheduledJobRun(runId, job, cronExpression, runAfterTime) {
  await ensureJobScheduleTable();
  const result = await query(
    `UPDATE scheduled_job_runs
     SET job_name = $2,
         cron_expression = $3,
         status = 'pending',
         run_after_time = $4,
         actual_run_time = NULL,
         error_reason = NULL,
         updated_at = $5
     WHERE id = $1
     RETURNING *`,
    [runId, job.displayName, cronExpression, runAfterTime, new Date()]
  );

  return result.rows[0] || null;
}

async function cancelPendingScheduledJobRun(runId, reason) {
  await ensureJobScheduleTable();
  const result = await query(
    `UPDATE scheduled_job_runs
     SET status = 'cancelled',
         error_reason = $2,
         updated_at = $3
     WHERE id = $1
     RETURNING *`,
    [runId, reason || null, new Date()]
  );

  return result.rows[0] || null;
}

async function getPendingScheduledJobRun(jobKey) {
  await ensureJobScheduleTable();
  const result = await query(
    `SELECT *
     FROM scheduled_job_runs
     WHERE job_key = $1
       AND status = 'pending'
     ORDER BY run_after_time ASC, id ASC
     LIMIT 1`,
    [jobKey]
  );

  return result.rows[0] || null;
}

module.exports = {
  ensureJobScheduleTable,
  syncPendingScheduledJobRuns,
  markScheduledJobRunStarted,
  finalizeScheduledJobRun,
  createNextPendingScheduledJobRun,
  getJobScheduleSummaries
};

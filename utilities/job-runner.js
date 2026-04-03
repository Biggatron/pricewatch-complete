const { Client } = require('pg');
const keys = require('../config/keys');
const crawler = require('./crawler');
const { ensureAppConfigTable, getAppConfig } = require('./app-config');
const { JOB_DEFINITIONS, getJobDefinition } = require('./job-definitions');
const {
  syncPendingScheduledJobRuns,
  markScheduledJobRunStarted,
  finalizeScheduledJobRun,
  createNextPendingScheduledJobRun
} = require('./job-schedule-log');

async function runDueJobs(options = {}) {
  await ensureAppConfigTable();
  const now = options.now instanceof Date ? options.now : new Date();
  const scheduleStateByJobKey = await syncPendingScheduledJobRuns(now);
  const results = [];

  for (const job of JOB_DEFINITIONS) {
    const scheduleState = scheduleStateByJobKey.get(job.key) || null;
    const enabled = scheduleState ? scheduleState.enabled : await getAppConfig(job.enabledConfigKey, job.defaultEnabled);
    const cronExpression = scheduleState ? scheduleState.cronExpression : String(await getAppConfig(job.cronConfigKey, job.defaultCron) || '').trim();
    const pendingRun = scheduleState && scheduleState.pendingRun ? scheduleState.pendingRun : null;

    if (!enabled) {
      results.push(buildSkippedResult(job, 'disabled', { cronExpression }));
      continue;
    }

    if (scheduleState && scheduleState.scheduleValid === false) {
      results.push(buildSkippedResult(job, 'invalid_schedule', {
        cronExpression,
        error: scheduleState.scheduleError || 'Invalid cron expression'
      }));
      continue;
    }

    const runAfterTime = pendingRun && pendingRun.run_after_time
      ? new Date(pendingRun.run_after_time)
      : null;
    const isDue = Boolean(runAfterTime && runAfterTime.getTime() <= now.getTime());

    if (!isDue) {
      results.push(buildSkippedResult(job, 'not_due', {
        cronExpression,
        runAfterTime
      }));
      continue;
    }

    const result = await runScheduledDueJob(job, {
      triggerType: 'scheduled',
      cronExpression,
      now,
      pendingRunId: pendingRun ? pendingRun.id : null,
      runAfterTime
    });

    results.push(result);
  }

  return results;
}

async function runScheduledDueJob(job, options = {}) {
  return withAdvisoryLock(job.lockId, async () => {
    const startedAt = new Date();

    if (options.pendingRunId) {
      await markScheduledJobRunStarted(options.pendingRunId, startedAt);
    }

    let status = 'completed';
    let summary = null;
    let errorMessage = null;

    try {
      summary = await executeJob(job, options);
    } catch (error) {
      status = 'failed';
      errorMessage = error && error.message ? error.message : 'Job execution failed';
      console.error('[jobs] Scheduled job failed', {
        jobKey: job.key,
        triggerType: options.triggerType || 'scheduled',
        error
      });
    }

    const finishedAt = new Date();

    if (options.pendingRunId) {
      await finalizeScheduledJobRun(options.pendingRunId, {
        status,
        errorReason: errorMessage
      });
    }

    if (options.cronExpression) {
      await createNextPendingScheduledJobRun(job, options.cronExpression, finishedAt);
    }

    return {
      jobKey: job.key,
      displayName: job.displayName,
      triggerType: options.triggerType || 'scheduled',
      status,
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      summary: summary == null ? null : summary,
      error: errorMessage
    };
  }, job);
}

async function runJob(jobKey, options = {}) {
  const job = getJobDefinition(jobKey);
  if (!job) {
    throw new Error(`Unknown job: ${jobKey}`);
  }

  await ensureAppConfigTable();

  return withAdvisoryLock(job.lockId, async () => {
    const startedAt = new Date();
    const summary = await executeJob(job, options);
    const finishedAt = new Date();

    return {
      jobKey: job.key,
      displayName: job.displayName,
      triggerType: options.triggerType || 'manual',
      status: 'completed',
      startedAt,
      finishedAt,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
      summary: summary == null ? null : summary
    };
  }, job);
}

async function startJob(jobKey, options = {}) {
  const job = getJobDefinition(jobKey);
  if (!job) {
    throw new Error(`Unknown job: ${jobKey}`);
  }

  await ensureAppConfigTable();

  const client = new Client({
    connectionString: keys.postgres.connectionString
  });

  await client.connect();

  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [job.lockId]
    );

    if (!result.rows[0] || !result.rows[0].locked) {
      await client.end().catch(() => null);
      return buildSkippedResult(job, 'locked');
    }

    const startedAt = new Date();
    Promise.resolve()
      .then(() => executeJob(job, options))
      .then((summary) => {
        console.info('[jobs] Background job completed', {
          jobKey: job.key,
          triggerType: options.triggerType || 'manual',
          summary
        });
      })
      .catch((error) => {
        console.error('[jobs] Background job failed', {
          jobKey: job.key,
          triggerType: options.triggerType || 'manual',
          error
        });
      })
      .finally(async () => {
        await client.query('SELECT pg_advisory_unlock($1)', [job.lockId]).catch(() => null);
        await client.end().catch(() => null);
      });

    return {
      jobKey: job.key,
      displayName: job.displayName,
      triggerType: options.triggerType || 'manual',
      status: 'started',
      startedAt
    };
  } catch (error) {
    await client.end().catch(() => null);
    throw error;
  }
}

async function executeJob(job, options) {
  if (job.key === 'crawler') {
    return crawler.updatePrices({
      triggerType: options.triggerType || 'manual',
      triggeredBy: options.triggeredBy || null
    });
  }

  if (job.key === 'preview_cleanup') {
    return crawler.cleanupStoredPreviewFiles();
  }

  if (job.key === 'email_delivery') {
    return crawler.deliverPendingEmails({
      ignoreSchedule: Boolean(options.ignoreSchedule)
    });
  }

  throw new Error(`No executor configured for job: ${job.key}`);
}

async function withAdvisoryLock(lockId, callback, job) {
  const client = new Client({
    connectionString: keys.postgres.connectionString
  });

  await client.connect();

  try {
    const result = await client.query(
      'SELECT pg_try_advisory_lock($1) AS locked',
      [lockId]
    );

    if (!result.rows[0] || !result.rows[0].locked) {
      return buildSkippedResult(job, 'locked');
    }

    try {
      return await callback();
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [lockId]).catch(() => null);
    }
  } finally {
    await client.end().catch(() => null);
  }
}

function buildSkippedResult(job, reason, extraFields = {}) {
  return {
    jobKey: job.key,
    displayName: job.displayName,
    status: reason,
    ...extraFields
  };
}

module.exports = {
  JOB_DEFINITIONS,
  runDueJobs,
  runJob,
  startJob
};

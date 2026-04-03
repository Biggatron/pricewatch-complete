const { initializeLogger } = require('../utilities/logger');
const { ensureAppConfigTable } = require('../utilities/app-config');
const { runDueJobs } = require('../utilities/job-runner');

initializeLogger({ announce: false });

main().catch((error) => {
  console.error('[cron-dispatcher] Job dispatch failed', error);
  process.exitCode = 1;
});

async function main() {
  await ensureAppConfigTable();
  const results = await runDueJobs();
  const summary = summarizeDispatchResults(results);
  if (!summary) {
    return;
  }

  const logMethod = summary.level === 'error'
    ? console.error
    : summary.level === 'warn'
      ? console.warn
      : console.info;

  logMethod('[cron-dispatcher] Dispatch cycle finished', {
    counts: summary.counts,
    jobs: summary.jobs
  });
}

function summarizeDispatchResults(results = []) {
  const significantJobs = results.filter(isSignificantDispatchResult).map((result) => ({
    jobKey: result.jobKey,
    displayName: result.displayName,
    status: result.status,
    triggerType: result.triggerType || null,
    runAfterTime: result.runAfterTime || null,
    startedAt: result.startedAt || null,
    finishedAt: result.finishedAt || null,
    durationMs: result.durationMs || null,
    summary: result.summary || null,
    error: result.error || null
  }));

  if (significantJobs.length === 0) {
    return null;
  }

  const counts = significantJobs.reduce((accumulator, job) => {
    const status = job.status || 'unknown';
    accumulator[status] = (accumulator[status] || 0) + 1;
    return accumulator;
  }, {});

  const hasErrors = significantJobs.some((job) => job.status === 'failed' || job.status === 'invalid_schedule');
  const hasWarnings = !hasErrors && significantJobs.some((job) => job.status === 'locked');

  return {
    level: hasErrors ? 'error' : hasWarnings ? 'warn' : 'info',
    counts,
    jobs: significantJobs
  };
}

function isSignificantDispatchResult(result) {
  if (!result || result.status === 'not_due' || result.status === 'disabled') {
    return false;
  }

  if (result.status === 'completed' && isNoOpScheduledSummary(result)) {
    return false;
  }

  return true;
}

function isNoOpScheduledSummary(result) {
  if (!result || result.status !== 'completed' || !result.summary) {
    return false;
  }

  if (result.jobKey === 'email_delivery') {
    return Number(result.summary.dueCount || 0) === 0
      && Number(result.summary.sentCount || 0) === 0
      && Number(result.summary.undeliverableCount || 0) === 0
      && Number(result.summary.skippedCount || 0) === 0;
  }

  if (result.jobKey === 'preview_cleanup') {
    return Number(result.summary.deletedCount || 0) === 0
      && Number(result.summary.missingFileCount || 0) === 0
      && Number(result.summary.orphanFileCount || 0) === 0
      && Number(result.summary.legacyMetadataFilesRemoved || 0) === 0;
  }

  return false;
}

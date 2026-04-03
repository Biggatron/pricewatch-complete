const { initializeLogger } = require('../utilities/logger');
const { ensureAppConfigTable } = require('../utilities/app-config');
const { runDueJobs } = require('../utilities/job-runner');

initializeLogger();

main().catch((error) => {
  console.error('[cron-dispatcher] Job dispatch failed', error);
  process.exitCode = 1;
});

async function main() {
  await ensureAppConfigTable();
  const results = await runDueJobs();
  console.info('[cron-dispatcher] Dispatch cycle finished', { results });
}

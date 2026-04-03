const { initializeLogger } = require('../utilities/logger');
const { ensureAppConfigTable } = require('../utilities/app-config');
const { runJob } = require('../utilities/job-runner');

initializeLogger();

main().catch((error) => {
  console.error('[run-job] Job execution failed', error);
  process.exitCode = 1;
});

async function main() {
  const jobKey = String(process.argv[2] || '').trim();
  if (!jobKey) {
    throw new Error('Job key is required. Example: node scripts/run-job.js crawler');
  }

  await ensureAppConfigTable();
  const result = await runJob(jobKey, {
    triggerType: 'manual-cli',
    ignoreSchedule: jobKey === 'email_delivery'
  });

  console.info('[run-job] Job finished', result);
}

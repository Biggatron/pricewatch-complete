const JOB_DEFINITIONS = [
  {
    key: 'crawler',
    displayName: 'Track crawler',
    description: 'Mass update all active tracks.',
    enabledConfigKey: 'jobs.crawler.enabled',
    cronConfigKey: 'jobs.crawler.cron',
    defaultEnabled: true,
    defaultCron: '0 0 * * *',
    lockId: 41001
  },
  {
    key: 'preview_cleanup',
    displayName: 'Preview cleanup',
    description: 'Delete expired screenshot preview files.',
    enabledConfigKey: 'jobs.preview_cleanup.enabled',
    cronConfigKey: 'jobs.preview_cleanup.cron',
    defaultEnabled: true,
    defaultCron: '*/30 * * * *',
    lockId: 41002
  },
  {
    key: 'email_delivery',
    displayName: 'Email delivery',
    description: 'Attempt delivery for due queued emails.',
    enabledConfigKey: 'jobs.email_delivery.enabled',
    cronConfigKey: 'jobs.email_delivery.cron',
    defaultEnabled: true,
    defaultCron: '*/5 * * * *',
    lockId: 41003
  }
];

function getJobDefinition(jobKey) {
  return JOB_DEFINITIONS.find((job) => job.key === jobKey) || null;
}

function getDefaultJobConfigEntries() {
  return JOB_DEFINITIONS.flatMap((job) => ([
    {
      config_key: job.enabledConfigKey,
      category: 'jobs',
      value: String(job.defaultEnabled),
      data_type: 'boolean',
      description: `Turns the ${job.displayName.toLowerCase()} scheduled job on or off.`,
      value_help: 'Checkbox. Manual admin actions still work even when the schedule is disabled.'
    },
    {
      config_key: job.cronConfigKey,
      category: 'jobs',
      value: job.defaultCron,
      data_type: 'string',
      description: `Cron expression for the ${job.displayName.toLowerCase()} job.`,
      value_help: '5-field cron expression in server local time. Example: */5 * * * *'
    }
  ]));
}

module.exports = {
  JOB_DEFINITIONS,
  getJobDefinition,
  getDefaultJobConfigEntries
};

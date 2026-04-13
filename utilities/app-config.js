const query = require('../db/db');
const constants = require('../config/const');
const keys = require('../config/keys');
const { getDefaultJobConfigEntries } = require('./job-definitions');

let tableReadyPromise = null;
const HIDDEN_CONFIG_KEYS = new Set([
  'crawler.schedule.enabled',
  'crawler.schedule.interval_ms'
]);
const MASKED_SECRET_VALUE = '********';

const defaultAppConfig = [
  {
    config_key: 'crawler.html_min_match_size',
    category: 'crawler',
    value: String(constants.crawler.htmlMinMatchSize),
    data_type: 'integer',
    description: 'Minimum amount of surrounding HTML used by the fallback regex matcher.',
    value_help: 'Whole number greater than 0. Smaller values make matching looser, larger values make matching stricter.'
  },
  {
    config_key: 'crawler.domain_access_profile_max_age_ms',
    category: 'crawler',
    value: String(constants.crawler.domainAccessProfileMaxAgeMs),
    data_type: 'integer',
    description: 'How long cached per-domain preview and crawler access settings stay trusted before being rediscovered.',
    value_help: 'Whole number greater than 0. Example: 604800000 = 7 days.'
  },
  {
    config_key: 'preview.screenshot_cache_duration_ms',
    category: 'preview',
    value: String(constants.preview.screenshotCacheDurationMs),
    data_type: 'integer',
    description: 'How long a generated screenshot preview stays cached before cleanup can remove it.',
    value_help: 'Whole number greater than 0. Example: 7200000 = 2 hours. Accessing a cached screenshot resets its expiry.'
  },
  {
    config_key: 'preview.post_navigation_delay_ms',
    category: 'preview',
    value: String(constants.preview.postNavigationDelayMs),
    data_type: 'integer',
    description: 'Extra wait time after DOM content loads before capturing a preview screenshot.',
    value_help: 'Whole number greater than or equal to 0. Example: 150 = 150 milliseconds.'
  },
  {
    config_key: 'preview.post_banner_delay_ms',
    category: 'preview',
    value: String(constants.preview.postBannerDelayMs),
    data_type: 'integer',
    description: 'Extra wait time after dismissing a cookie banner before capturing a preview screenshot.',
    value_help: 'Whole number greater than or equal to 0. Example: 250 = 250 milliseconds.'
  },
  {
    config_key: 'email.send_enabled',
    category: 'email',
    value: String(constants.email.sendEmail),
    data_type: 'boolean',
    description: 'Turns outgoing emails on or off.',
    value_help: 'Checkbox. When disabled, email logs are still recorded but messages are not sent.'
  },
  {
    config_key: 'email.transport_mode',
    category: 'email',
    value: constants.email.transportMode,
    data_type: 'string',
    description: 'Controls whether outgoing mail uses SMTP or Amazon SES.',
    value_help: 'Allowed values: smtp, ses. Defaults to smtp outside production and ses in production.'
  },
  {
    config_key: 'email.retry_delay_ms',
    category: 'email',
    value: String(constants.email.retryDelayMs),
    data_type: 'integer',
    description: 'Wait time before retrying a failed email delivery.',
    value_help: 'Whole number greater than or equal to 0. Example: 900000 = 15 minutes.'
  },
  {
    config_key: 'email.ses_address',
    category: 'email',
    value: constants.email.sesAddress,
    data_type: 'string',
    description: 'The sender email address used when outgoing mail is sent through Amazon SES.',
    value_help: 'Text value. Example: pricewatcher@birgirs.com.'
  },
  {
    config_key: 'email.service',
    category: 'email',
    value: (keys.email && keys.email.service) || '',
    data_type: 'string',
    description: 'The email provider/service name used by Nodemailer.',
    value_help: 'Text value. Example: gmail.'
  },
  {
    config_key: 'email.address',
    category: 'email',
    value: (keys.email && keys.email.address) || '',
    data_type: 'string',
    description: 'The sender email address used for outgoing emails.',
    value_help: 'Text value. Example: name@example.com.'
  },
  {
    config_key: 'email.password',
    category: 'email',
    value: '',
    data_type: 'secret',
    description: 'The password or app password used to authenticate the sender email account.',
    value_help: 'Secret text value. Keep this private.'
  },
  {
    config_key: 'html.save_new_track_html',
    category: 'html',
    value: String(constants.html.saveNewTrackHTML),
    data_type: 'boolean',
    description: 'Controls whether HTML snapshots are saved while creating new tracks.',
    value_help: 'Checkbox. Works together with html.only_failed.'
  },
  {
    config_key: 'html.save_update_track_html',
    category: 'html',
    value: String(constants.html.saveUpdateTrackHTML),
    data_type: 'boolean',
    description: 'Controls whether HTML snapshots are saved during crawler updates.',
    value_help: 'Checkbox. Works together with html.only_failed.'
  },
  {
    config_key: 'html.only_failed',
    category: 'html',
    value: String(constants.html.onlyFailed),
    data_type: 'boolean',
    description: 'When enabled, HTML snapshots are only saved for failures.',
    value_help: 'Checkbox. When disabled, snapshots are saved whenever the related save flag is enabled.'
  },
  ...getDefaultJobConfigEntries()
];

async function ensureAppConfigTable() {
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
    CREATE TABLE IF NOT EXISTS app_config (
      "id" serial PRIMARY KEY,
      "config_key" varchar(128) NOT NULL UNIQUE,
      "category" varchar(64),
      "value" text,
      "data_type" varchar(32) NOT NULL DEFAULT 'string',
      "description" text,
      "value_help" text,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  await query(`
    ALTER TABLE app_config
      ADD COLUMN IF NOT EXISTS config_key varchar(128),
      ADD COLUMN IF NOT EXISTS category varchar(64),
      ADD COLUMN IF NOT EXISTS value text,
      ADD COLUMN IF NOT EXISTS data_type varchar(32) NOT NULL DEFAULT 'string',
      ADD COLUMN IF NOT EXISTS description text,
      ADD COLUMN IF NOT EXISTS value_help text,
      ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now()
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS app_config_config_key_idx
    ON app_config (config_key)
  `);

  for (const entry of defaultAppConfig) {
    await query(
      `INSERT INTO app_config (
        config_key,
        category,
        value,
        data_type,
        description,
        value_help
      ) VALUES ($1, $2, $3, $4, $5, $6)
      ON CONFLICT (config_key) DO NOTHING`,
      [
        entry.config_key,
        entry.category,
        entry.value,
        entry.data_type,
        entry.description,
        entry.value_help
      ]
    );
  }

  for (const entry of defaultAppConfig) {
    await query(
      `UPDATE app_config
       SET category = COALESCE(category, $2),
           data_type = COALESCE(data_type, $3),
           description = COALESCE(description, $4),
           value_help = COALESCE(value_help, $5)
       WHERE config_key = $1`,
      [
        entry.config_key,
        entry.category,
        entry.data_type,
        entry.description,
        entry.value_help
      ]
    );
  }
}

async function getAppConfig(key, fallbackValue = null) {
  const row = await getAppConfigRow(key);
  if (!row) {
    return fallbackValue;
  }

  return parseAppConfigValue(row, fallbackValue);
}

async function getAppConfigRow(key) {
  await ensureAppConfigTable();
  const result = await query(
    `SELECT *
     FROM app_config
     WHERE config_key = $1`,
    [key]
  );

  if (!result.rows[0]) {
    return null;
  }

  return result.rows[0];
}

async function setAppConfig({ key, category, value, dataType = 'string', description = null, valueHelp = null }) {
  await ensureAppConfigTable();
  const normalizedValue = typeof value === 'string' ? value : JSON.stringify(value);
  const result = await query(
    `INSERT INTO app_config (
      config_key,
      category,
      value,
      data_type,
      description,
      value_help,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (config_key) DO UPDATE SET
      category = EXCLUDED.category,
      value = EXCLUDED.value,
      data_type = EXCLUDED.data_type,
      description = COALESCE(EXCLUDED.description, app_config.description),
      value_help = COALESCE(EXCLUDED.value_help, app_config.value_help),
      updated_at = EXCLUDED.updated_at
    RETURNING *`,
    [
      key,
      category || null,
      normalizedValue,
      dataType,
      description,
      valueHelp,
      new Date()
    ]
  );

  return result.rows[0];
}

async function getAllAppConfig() {
  await ensureAppConfigTable();
  const result = await query(
    `SELECT *
     FROM app_config
     ORDER BY category ASC NULLS LAST, config_key ASC`
  );

  return result.rows
    .filter((row) => !HIDDEN_CONFIG_KEYS.has(row.config_key))
    .map((row) => sanitizeAppConfigRow(row));
}

function sanitizeAppConfigRow(row) {
  const isSecret = row && row.data_type === 'secret';
  const hasStoredValue = Boolean(row && row.value);
  const parsedValue = isSecret
    ? null
    : parseAppConfigValue(row, null);

  return {
    ...row,
    value: isSecret ? '' : row.value,
    parsed_value: parsedValue,
    has_stored_value: hasStoredValue,
    masked_value: isSecret && hasStoredValue ? MASKED_SECRET_VALUE : ''
  };
}

function parseAppConfigValue(row, fallbackValue) {
  const rawValue = row.value;

  if (rawValue == null) {
    return fallbackValue;
  }

  if (row.data_type === 'boolean') {
    return rawValue === 'true';
  }

  if (row.data_type === 'integer') {
    const parsed = Number.parseInt(rawValue, 10);
    return Number.isFinite(parsed) ? parsed : fallbackValue;
  }

  if (row.data_type === 'number') {
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? parsed : fallbackValue;
  }

  if (row.data_type === 'json') {
    try {
      return JSON.parse(rawValue);
    } catch (error) {
      return fallbackValue;
    }
  }

  return rawValue;
}

module.exports = {
  defaultAppConfig,
  ensureAppConfigTable,
  getAppConfig,
  getAppConfigRow,
  setAppConfig,
  getAllAppConfig
};

const query = require('../db/db');
const constants = require('../config/const');
const { getAppConfig } = require('./app-config');

const DOMAIN_ACCESS_PROFILE_MAX_AGE_CONFIG_KEY = 'crawler.domain_access_profile_max_age_ms';

const DOMAIN_PROFILE_PREVIEW_MODES = {
  IFRAME: 'iframe',
  SCREENSHOT: 'screenshot'
};

const DOMAIN_PROFILE_CRAWLER_MODES = {
  DIRECT_HTML: 'direct_html',
  HEADLESS_BROWSER: 'headless_browser'
};

const DOMAIN_PROFILE_PRICE_LOOKUP_MODES = {
  DIV_STRUCTURE: 'div_structure',
  STRING_MATCH: 'string_match'
};

let tableReadyPromise = null;

async function ensureDomainAccessProfileTable() {
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
    CREATE TABLE IF NOT EXISTS domain_access_profiles (
      "id" serial PRIMARY KEY,
      "domain" varchar(255) NOT NULL UNIQUE,
      "preview_mode" varchar(32),
      "crawler_mode" varchar(32),
      "price_lookup_mode" varchar(32),
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  await query(`
    ALTER TABLE domain_access_profiles
      ADD COLUMN IF NOT EXISTS domain varchar(255),
      ADD COLUMN IF NOT EXISTS preview_mode varchar(32),
      ADD COLUMN IF NOT EXISTS crawler_mode varchar(32),
      ADD COLUMN IF NOT EXISTS price_lookup_mode varchar(32),
      ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now()
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS domain_access_profiles_domain_idx
    ON domain_access_profiles (domain)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS domain_access_profiles_updated_at_idx
    ON domain_access_profiles (updated_at)
  `);
}

function normalizeDomain(value) {
  if (!value) {
    return null;
  }

  let hostname = String(value).trim();
  if (!hostname) {
    return null;
  }

  try {
    hostname = new URL(hostname).hostname;
  } catch (error) {
    hostname = hostname.replace(/^https?:\/\//i, '').split(/[/?#]/)[0];
  }

  hostname = hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  return hostname || null;
}

function extractDomainFromUrl(url) {
  return normalizeDomain(url);
}

function normalizePreviewMode(value) {
  return Object.values(DOMAIN_PROFILE_PREVIEW_MODES).includes(value) ? value : null;
}

function normalizeCrawlerMode(value) {
  return Object.values(DOMAIN_PROFILE_CRAWLER_MODES).includes(value) ? value : null;
}

function normalizePriceLookupMode(value) {
  return Object.values(DOMAIN_PROFILE_PRICE_LOOKUP_MODES).includes(value) ? value : null;
}

async function getDomainAccessProfileByDomain(domain) {
  const normalizedDomain = normalizeDomain(domain);
  if (!normalizedDomain) {
    return null;
  }

  await ensureDomainAccessProfileTable();
  const result = await query(
    `SELECT *
     FROM domain_access_profiles
     WHERE domain = $1
     LIMIT 1`,
    [normalizedDomain]
  );

  return result.rows[0] || null;
}

async function getDomainAccessProfileByUrl(url) {
  return getDomainAccessProfileByDomain(extractDomainFromUrl(url));
}

async function getDomainAccessProfileMaxAgeMs() {
  const fallbackValue = constants.crawler && Number.isFinite(constants.crawler.domainAccessProfileMaxAgeMs)
    ? constants.crawler.domainAccessProfileMaxAgeMs
    : 1000 * 60 * 60 * 24 * 7;
  const configuredValue = await getAppConfig(DOMAIN_ACCESS_PROFILE_MAX_AGE_CONFIG_KEY, fallbackValue);
  const parsedValue = Number(configuredValue);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallbackValue;
  }

  return Math.floor(parsedValue);
}

async function getFreshDomainAccessProfileByUrl(url) {
  const profile = await getDomainAccessProfileByUrl(url);
  if (!profile) {
    return null;
  }

  const updatedAt = profile.updated_at ? new Date(profile.updated_at) : null;
  if (!updatedAt || !Number.isFinite(updatedAt.getTime())) {
    return null;
  }

  const maxAgeMs = await getDomainAccessProfileMaxAgeMs();
  if ((Date.now() - updatedAt.getTime()) > maxAgeMs) {
    return null;
  }

  return profile;
}

async function upsertDomainAccessProfile({
  domain,
  url,
  previewMode = null,
  crawlerMode = null,
  priceLookupMode = null,
  updatedAt = new Date()
}) {
  const normalizedDomain = normalizeDomain(domain || extractDomainFromUrl(url));
  const normalizedPreviewMode = normalizePreviewMode(previewMode);
  const normalizedCrawlerMode = normalizeCrawlerMode(crawlerMode);
  const normalizedPriceLookupMode = normalizePriceLookupMode(priceLookupMode);

  if (!normalizedDomain) {
    return null;
  }

  if (!normalizedPreviewMode && !normalizedCrawlerMode && !normalizedPriceLookupMode) {
    return getDomainAccessProfileByDomain(normalizedDomain);
  }

  await ensureDomainAccessProfileTable();
  const result = await query(
    `INSERT INTO domain_access_profiles (
      domain,
      preview_mode,
      crawler_mode,
      price_lookup_mode,
      created_at,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $5)
    ON CONFLICT (domain) DO UPDATE SET
      preview_mode = COALESCE(EXCLUDED.preview_mode, domain_access_profiles.preview_mode),
      crawler_mode = COALESCE(EXCLUDED.crawler_mode, domain_access_profiles.crawler_mode),
      price_lookup_mode = COALESCE(EXCLUDED.price_lookup_mode, domain_access_profiles.price_lookup_mode),
      updated_at = EXCLUDED.updated_at
    RETURNING *`,
    [
      normalizedDomain,
      normalizedPreviewMode,
      normalizedCrawlerMode,
      normalizedPriceLookupMode,
      updatedAt
    ]
  );

  return result.rows[0] || null;
}

module.exports = {
  DOMAIN_ACCESS_PROFILE_MAX_AGE_CONFIG_KEY,
  DOMAIN_PROFILE_PREVIEW_MODES,
  DOMAIN_PROFILE_CRAWLER_MODES,
  DOMAIN_PROFILE_PRICE_LOOKUP_MODES,
  ensureDomainAccessProfileTable,
  extractDomainFromUrl,
  getDomainAccessProfileByDomain,
  getDomainAccessProfileByUrl,
  getDomainAccessProfileMaxAgeMs,
  getFreshDomainAccessProfileByUrl,
  normalizeDomain,
  upsertDomainAccessProfile
};

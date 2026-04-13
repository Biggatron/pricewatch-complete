const query = require('../db/db');
const { extractDomainFromUrl, normalizeDomain } = require('./domain-access-profile');

const DOMAIN_PRICE_SELECTOR_TYPES = {
  JSON_LD: 'json_ld',
  NEXT_DATA: 'next_data',
  CSS: 'css',
  HTML_ID: 'html_id',
  HTML_PATTERN: 'html_pattern'
};

const ACTIVE_SELECTOR_TYPES = [
  DOMAIN_PRICE_SELECTOR_TYPES.JSON_LD,
  DOMAIN_PRICE_SELECTOR_TYPES.NEXT_DATA,
  DOMAIN_PRICE_SELECTOR_TYPES.CSS,
  DOMAIN_PRICE_SELECTOR_TYPES.HTML_ID
];

let tableReadyPromise = null;

async function ensureDomainPriceSelectorTable() {
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
    CREATE TABLE IF NOT EXISTS domain_price_selectors (
      "id" serial PRIMARY KEY,
      "domain" varchar(255) NOT NULL,
      "template_key" varchar(128) NOT NULL,
      "selector_type" varchar(32) NOT NULL,
      "selector_value" text,
      "requires_javascript" boolean NOT NULL DEFAULT FALSE,
      "source_track_id" integer,
      "success_count" integer NOT NULL DEFAULT 0,
      "failure_count" integer NOT NULL DEFAULT 0,
      "last_verified_at" timestamp,
      "last_failed_at" timestamp,
      "is_active" boolean NOT NULL DEFAULT TRUE,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "updated_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  await query(`
    ALTER TABLE domain_price_selectors
      ADD COLUMN IF NOT EXISTS domain varchar(255),
      ADD COLUMN IF NOT EXISTS template_key varchar(128),
      ADD COLUMN IF NOT EXISTS selector_type varchar(32),
      ADD COLUMN IF NOT EXISTS selector_value text,
      ADD COLUMN IF NOT EXISTS requires_javascript boolean NOT NULL DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS source_track_id integer,
      ADD COLUMN IF NOT EXISTS success_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS failure_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_verified_at timestamp,
      ADD COLUMN IF NOT EXISTS last_failed_at timestamp,
      ADD COLUMN IF NOT EXISTS is_active boolean NOT NULL DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS updated_at timestamp NOT NULL DEFAULT now()
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS domain_price_selectors_domain_template_type_js_unique_idx
    ON domain_price_selectors (domain, template_key, selector_type, requires_javascript)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS domain_price_selectors_domain_active_idx
    ON domain_price_selectors (domain, is_active, updated_at DESC)
  `);
}

function normalizeSelectorType(value) {
  return Object.values(DOMAIN_PRICE_SELECTOR_TYPES).includes(value) ? value : null;
}

function normalizeTemplateKey(value) {
  const templateKey = String(value || '').trim().toLowerCase();
  return templateKey || 'default';
}

async function upsertDomainPriceSelector({
  domain,
  url,
  templateKey = 'default',
  selectorType,
  selectorValue = '',
  requiresJavascript = false,
  sourceTrackId = null,
  verifiedAt = new Date()
}) {
  await ensureDomainPriceSelectorTable();

  const normalizedDomain = normalizeDomain(domain || extractDomainFromUrl(url));
  const normalizedSelectorType = normalizeSelectorType(selectorType);
  const normalizedTemplateKey = normalizeTemplateKey(templateKey);

  if (!normalizedDomain || !normalizedSelectorType) {
    return null;
  }

  const result = await query(
    `INSERT INTO domain_price_selectors (
      domain,
      template_key,
      selector_type,
      selector_value,
      requires_javascript,
      source_track_id,
      success_count,
      failure_count,
      last_verified_at,
      last_failed_at,
      is_active,
      created_at,
      updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, 1, 0, $7, NULL, TRUE, $7, $7)
    ON CONFLICT (domain, template_key, selector_type, requires_javascript) DO UPDATE SET
      selector_value = EXCLUDED.selector_value,
      source_track_id = COALESCE(EXCLUDED.source_track_id, domain_price_selectors.source_track_id),
      success_count = domain_price_selectors.success_count + 1,
      last_verified_at = EXCLUDED.last_verified_at,
      is_active = TRUE,
      updated_at = EXCLUDED.updated_at
    RETURNING *`,
    [
      normalizedDomain,
      normalizedTemplateKey,
      normalizedSelectorType,
      selectorValue || '',
      Boolean(requiresJavascript),
      sourceTrackId,
      verifiedAt
    ]
  );

  return result.rows[0] || null;
}

async function getDomainPriceSelectorsByUrl(url, options = {}) {
  await ensureDomainPriceSelectorTable();

  const normalizedDomain = extractDomainFromUrl(url);
  if (!normalizedDomain) {
    return [];
  }

  const params = [normalizedDomain];
  const conditions = ['domain = $1'];

  params.push(ACTIVE_SELECTOR_TYPES);
  conditions.push(`selector_type = ANY($${params.length})`);

  if (options.isActiveOnly !== false) {
    conditions.push('is_active = TRUE');
  }

  if (typeof options.requiresJavascript === 'boolean') {
    params.push(options.requiresJavascript);
    conditions.push(`requires_javascript = $${params.length}`);
  }

  const result = await query(
    `SELECT *
     FROM domain_price_selectors
     WHERE ${conditions.join(' AND ')}
     ORDER BY
       CASE selector_type
         WHEN '${DOMAIN_PRICE_SELECTOR_TYPES.JSON_LD}' THEN 1
         WHEN '${DOMAIN_PRICE_SELECTOR_TYPES.NEXT_DATA}' THEN 2
         WHEN '${DOMAIN_PRICE_SELECTOR_TYPES.CSS}' THEN 3
         WHEN '${DOMAIN_PRICE_SELECTOR_TYPES.HTML_ID}' THEN 4
         WHEN '${DOMAIN_PRICE_SELECTOR_TYPES.HTML_PATTERN}' THEN 9
         ELSE 10
       END ASC,
       success_count DESC,
       failure_count ASC,
       last_verified_at DESC NULLS LAST,
       updated_at DESC`,
    params
  );

  return result.rows;
}

async function markDomainPriceSelectorSuccess(selectorId, verifiedAt = new Date()) {
  if (!Number.isInteger(Number(selectorId))) {
    return null;
  }

  await ensureDomainPriceSelectorTable();
  const result = await query(
    `UPDATE domain_price_selectors
     SET success_count = success_count + 1,
         last_verified_at = $2,
         is_active = TRUE,
         updated_at = $2
     WHERE id = $1
     RETURNING *`,
    [selectorId, verifiedAt]
  );

  return result.rows[0] || null;
}

async function markDomainPriceSelectorFailure(selectorId, failedAt = new Date()) {
  if (!Number.isInteger(Number(selectorId))) {
    return null;
  }

  await ensureDomainPriceSelectorTable();
  const result = await query(
    `UPDATE domain_price_selectors
     SET failure_count = failure_count + 1,
         last_failed_at = $2,
         updated_at = $2
     WHERE id = $1
     RETURNING *`,
    [selectorId, failedAt]
  );

  return result.rows[0] || null;
}

module.exports = {
  DOMAIN_PRICE_SELECTOR_TYPES,
  ensureDomainPriceSelectorTable,
  getDomainPriceSelectorsByUrl,
  markDomainPriceSelectorFailure,
  markDomainPriceSelectorSuccess,
  normalizeSelectorType,
  normalizeTemplateKey,
  upsertDomainPriceSelector
};

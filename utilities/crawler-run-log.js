const query = require('../db/db');

let tableReadyPromise = null;

async function ensureCrawlerRunTables() {
  if (!tableReadyPromise) {
    tableReadyPromise = ensureTables().catch((error) => {
      tableReadyPromise = null;
      throw error;
    });
  }

  await tableReadyPromise;
}

async function ensureTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS crawler_runs (
      "id" serial PRIMARY KEY,
      "trigger_type" varchar(64),
      "triggered_by_user_id" integer,
      "triggered_by_email" varchar(256),
      "status" varchar(32),
      "started_at" timestamp NOT NULL DEFAULT now(),
      "finished_at" timestamp,
      "duration_ms" integer,
      "track_count" integer DEFAULT 0,
      "html_success_count" integer DEFAULT 0,
      "html_failure_count" integer DEFAULT 0,
      "unchanged_count" integer DEFAULT 0,
      "updated_count" integer DEFAULT 0,
      "lowered_count" integer DEFAULT 0,
      "increased_count" integer DEFAULT 0,
      "inactive_count" integer DEFAULT 0,
      "reactivated_count" integer DEFAULT 0,
      "error_count" integer DEFAULT 0,
      "biggest_drop_amount" numeric,
      "biggest_increase_amount" numeric
    )
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS crawler_run_items (
      "id" serial PRIMARY KEY,
      "run_id" integer,
      "track_id" integer,
      "user_id" integer,
      "product_name" varchar(256),
      "product_url" varchar(2048),
      "requires_javascript" boolean,
      "status" varchar(64),
      "stage" varchar(64),
      "html_lookup_success" boolean,
      "previous_price" numeric,
      "current_price" numeric,
      "price_direction" varchar(32),
      "marked_inactive" boolean DEFAULT FALSE,
      "reactivated" boolean DEFAULT FALSE,
      "failure_log_id" integer,
      "error_message" text,
      "duration_ms" integer,
      "created_at" timestamp NOT NULL DEFAULT now()
    )
  `);

  await query(`
    ALTER TABLE crawler_runs
      ADD COLUMN IF NOT EXISTS trigger_type varchar(64),
      ADD COLUMN IF NOT EXISTS triggered_by_user_id integer,
      ADD COLUMN IF NOT EXISTS triggered_by_email varchar(256),
      ADD COLUMN IF NOT EXISTS status varchar(32),
      ADD COLUMN IF NOT EXISTS started_at timestamp NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS finished_at timestamp,
      ADD COLUMN IF NOT EXISTS duration_ms integer,
      ADD COLUMN IF NOT EXISTS track_count integer DEFAULT 0,
      ADD COLUMN IF NOT EXISTS html_success_count integer DEFAULT 0,
      ADD COLUMN IF NOT EXISTS html_failure_count integer DEFAULT 0,
      ADD COLUMN IF NOT EXISTS unchanged_count integer DEFAULT 0,
      ADD COLUMN IF NOT EXISTS updated_count integer DEFAULT 0,
      ADD COLUMN IF NOT EXISTS lowered_count integer DEFAULT 0,
      ADD COLUMN IF NOT EXISTS increased_count integer DEFAULT 0,
      ADD COLUMN IF NOT EXISTS inactive_count integer DEFAULT 0,
      ADD COLUMN IF NOT EXISTS reactivated_count integer DEFAULT 0,
      ADD COLUMN IF NOT EXISTS error_count integer DEFAULT 0,
      ADD COLUMN IF NOT EXISTS biggest_drop_amount numeric,
      ADD COLUMN IF NOT EXISTS biggest_increase_amount numeric
  `);

  await query(`
    ALTER TABLE crawler_run_items
      ADD COLUMN IF NOT EXISTS run_id integer,
      ADD COLUMN IF NOT EXISTS track_id integer,
      ADD COLUMN IF NOT EXISTS user_id integer,
      ADD COLUMN IF NOT EXISTS product_name varchar(256),
      ADD COLUMN IF NOT EXISTS product_url varchar(2048),
      ADD COLUMN IF NOT EXISTS requires_javascript boolean,
      ADD COLUMN IF NOT EXISTS status varchar(64),
      ADD COLUMN IF NOT EXISTS stage varchar(64),
      ADD COLUMN IF NOT EXISTS html_lookup_success boolean,
      ADD COLUMN IF NOT EXISTS previous_price numeric,
      ADD COLUMN IF NOT EXISTS current_price numeric,
      ADD COLUMN IF NOT EXISTS price_direction varchar(32),
      ADD COLUMN IF NOT EXISTS marked_inactive boolean DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS reactivated boolean DEFAULT FALSE,
      ADD COLUMN IF NOT EXISTS failure_log_id integer,
      ADD COLUMN IF NOT EXISTS error_message text,
      ADD COLUMN IF NOT EXISTS duration_ms integer,
      ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now()
  `);
}

async function createCrawlerRun(run) {
  await ensureCrawlerRunTables();
  const result = await query(
    `INSERT INTO crawler_runs (
      trigger_type,
      triggered_by_user_id,
      triggered_by_email,
      status,
      started_at
    ) VALUES ($1, $2, $3, $4, $5)
    RETURNING *`,
    [
      run.trigger_type,
      run.triggered_by_user_id || null,
      run.triggered_by_email || null,
      run.status || 'running',
      run.started_at || new Date()
    ]
  );
  return result.rows[0];
}

async function finalizeCrawlerRun(runId, summary) {
  await ensureCrawlerRunTables();
  const result = await query(
    `UPDATE crawler_runs
     SET status = $1,
         finished_at = $2,
         duration_ms = $3,
         track_count = $4,
         html_success_count = $5,
         html_failure_count = $6,
         unchanged_count = $7,
         updated_count = $8,
         lowered_count = $9,
         increased_count = $10,
         inactive_count = $11,
         reactivated_count = $12,
         error_count = $13,
         biggest_drop_amount = $14,
         biggest_increase_amount = $15
     WHERE id = $16
     RETURNING *`,
    [
      summary.status,
      summary.finished_at,
      summary.duration_ms,
      summary.track_count,
      summary.html_success_count,
      summary.html_failure_count,
      summary.unchanged_count,
      summary.updated_count,
      summary.lowered_count,
      summary.increased_count,
      summary.inactive_count,
      summary.reactivated_count,
      summary.error_count,
      summary.biggest_drop_amount,
      summary.biggest_increase_amount,
      runId
    ]
  );
  return result.rows[0];
}

async function insertCrawlerRunItem(item) {
  await ensureCrawlerRunTables();
  const result = await query(
    `INSERT INTO crawler_run_items (
      run_id,
      track_id,
      user_id,
      product_name,
      product_url,
      requires_javascript,
      status,
      stage,
      html_lookup_success,
      previous_price,
      current_price,
      price_direction,
      marked_inactive,
      reactivated,
      failure_log_id,
      error_message,
      duration_ms,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
    RETURNING *`,
    [
      item.run_id,
      item.track_id || null,
      item.user_id || null,
      item.product_name || null,
      item.product_url || null,
      typeof item.requires_javascript === 'boolean' ? item.requires_javascript : null,
      item.status || null,
      item.stage || null,
      typeof item.html_lookup_success === 'boolean' ? item.html_lookup_success : null,
      item.previous_price != null ? item.previous_price : null,
      item.current_price != null ? item.current_price : null,
      item.price_direction || null,
      Boolean(item.marked_inactive),
      Boolean(item.reactivated),
      item.failure_log_id || null,
      item.error_message || null,
      item.duration_ms || null,
      item.created_at || new Date()
    ]
  );
  return result.rows[0];
}

async function getRecentCrawlerRuns(limit = 20) {
  await ensureCrawlerRunTables();
  const result = await query(
    `SELECT *
     FROM crawler_runs
     ORDER BY started_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

async function getCrawlerRunById(id) {
  await ensureCrawlerRunTables();
  const result = await query(
    `SELECT *
     FROM crawler_runs
     WHERE id = $1`,
    [id]
  );
  return result.rows[0] || null;
}

async function getCrawlerRunItems(runId) {
  await ensureCrawlerRunTables();
  const result = await query(
    `SELECT *
     FROM crawler_run_items
     WHERE run_id = $1
     ORDER BY created_at ASC, id ASC`,
    [runId]
  );
  return result.rows;
}

module.exports = {
  ensureCrawlerRunTables,
  createCrawlerRun,
  finalizeCrawlerRun,
  insertCrawlerRunItem,
  getRecentCrawlerRuns,
  getCrawlerRunById,
  getCrawlerRunItems
};

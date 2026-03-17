const fs = require('fs');
const path = require('path');
const query = require('../db/db');
const keys = require('../config/keys');

let tableReadyPromise = null;

async function ensureCrawlerFailureLogTable() {
  if (!tableReadyPromise) {
    tableReadyPromise = query(`
      CREATE TABLE IF NOT EXISTS crawler_failure_logs (
        "id" serial PRIMARY KEY,
        "track_id" integer,
        "user_id" integer,
        "user_email" varchar(256),
        "action" varchar(64),
        "stage" varchar(64),
        "product_name" varchar(256),
        "product_url" varchar(2048),
        "requires_javascript" boolean,
        "html_file_path" varchar(1024),
        "error_message" text,
        "error_stack" text,
        "details" text,
        "created_at" timestamp NOT NULL DEFAULT now()
      )
    `).catch((error) => {
      tableReadyPromise = null;
      throw error;
    });
  }

  await tableReadyPromise;
}

async function insertCrawlerFailureLog(entry) {
  await ensureCrawlerFailureLogTable();

  const result = await query(
    `INSERT INTO crawler_failure_logs (
      track_id,
      user_id,
      user_email,
      action,
      stage,
      product_name,
      product_url,
      requires_javascript,
      html_file_path,
      error_message,
      error_stack,
      details,
      created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
    RETURNING *`,
    [
      entry.track_id || null,
      entry.user_id || null,
      entry.user_email || null,
      entry.action || null,
      entry.stage || null,
      entry.product_name || null,
      entry.product_url || null,
      typeof entry.requires_javascript === 'boolean' ? entry.requires_javascript : null,
      entry.html_file_path || null,
      entry.error_message || null,
      entry.error_stack || null,
      entry.details ? JSON.stringify(entry.details) : null,
      entry.created_at || new Date()
    ]
  );

  return result.rows[0];
}

async function getRecentCrawlerFailureLogs(limit = 25) {
  await ensureCrawlerFailureLogTable();
  const result = await query(
    `SELECT *
     FROM crawler_failure_logs
     ORDER BY created_at DESC
     LIMIT $1`,
    [limit]
  );
  return result.rows;
}

async function getCrawlerFailureLogById(id) {
  await ensureCrawlerFailureLogTable();
  const result = await query(
    `SELECT *
     FROM crawler_failure_logs
     WHERE id = $1`,
    [id]
  );

  const failure = result.rows[0];
  if (!failure) {
    return null;
  }

  let htmlContent = '';
  if (failure.html_file_path) {
    try {
      const fullPath = path.resolve(process.cwd(), failure.html_file_path);
      htmlContent = await fs.promises.readFile(fullPath, 'utf8');
    } catch (error) {
      htmlContent = `Failed to read saved HTML file: ${error.message}`;
    }
  }

  return {
    ...failure,
    details: parseDetails(failure.details),
    html_content: htmlContent
  };
}

function parseDetails(details) {
  if (!details) {
    return null;
  }

  try {
    return JSON.parse(details);
  } catch (error) {
    return { raw: details };
  }
}

module.exports = {
  ensureCrawlerFailureLogTable,
  insertCrawlerFailureLog,
  getRecentCrawlerFailureLogs,
  getCrawlerFailureLogById
};

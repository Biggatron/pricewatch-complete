const puppeteer = require('puppeteer');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const query = require('../db/db');
const keys = require('../config/keys');
const constants = require('../config/const');
const nodemailer = require('nodemailer');
const { SESv2Client, SendEmailCommand } = require('@aws-sdk/client-sesv2');
const { getAppConfig } = require('./app-config');
const {
  insertCrawlerFailureLog,
  updateCrawlerFailureLogLinks
} = require('./crawler-failure-log');
const {
  createCrawlerRun,
  finalizeCrawlerRun,
  insertCrawlerRunItem
} = require('./crawler-run-log');
const { insertTrackHistoryEntry } = require('./track-history-log');
const { ensureTrackSoftDeleteColumn } = require('./track-soft-delete');
const { renderEmailTemplate } = require('./email-template');
const MAX_MATCH_PRICE = 1000000000;
const MAX_EMAIL_DELIVERY_ATTEMPTS = 3;
const PREVIEW_OUTPUT_DIR = path.join(__dirname, '..', 'public', 'generated-previews');
const PREVIEW_IMAGE_EXTENSION = '.png';
const PREVIEW_TIMEOUT_MS = 6000;
const PREVIEW_CLEANUP_INTERVAL_MS = 1000 * 60 * 10;
const PREVIEW_ORPHAN_GRACE_MS = 1000 * 60 * 5;
const PREVIEW_CACHE_CONFIG_KEY = 'preview.screenshot_cache_duration_ms';
const PREVIEW_POST_NAVIGATION_DELAY_CONFIG_KEY = 'preview.post_navigation_delay_ms';
const PREVIEW_POST_BANNER_DELAY_CONFIG_KEY = 'preview.post_banner_delay_ms';
const PREVIEW_VIEWPORT = {
  width: 1280,
  height: 1600
};
const previewScreenshotInflight = new Map();
let previewBrowserPromise = null;
let lastPreviewCleanupAt = 0;
let previewCacheTableReadyPromise = null;
let previewLegacyMigrationPromise = null;

module.exports = {
  updatePrices,
  extractNumber,
  findAndSavePrices,
  updateSingleTrack,
  getTrackHtmlPreview,
  getUrlPreview,
  deliverPendingEmails,
  sendTemplateTestEmail,
  cleanupStoredPreviewFiles,
  getPreviewCacheSummary
};

async function ensurePreviewCacheTable() {
  if (!previewCacheTableReadyPromise) {
    previewCacheTableReadyPromise = ensurePreviewCacheTableInternal().catch((error) => {
      previewCacheTableReadyPromise = null;
      throw error;
    });
  }

  await previewCacheTableReadyPromise;
  await ensureLegacyPreviewMetadataMigrated();
}

async function ensurePreviewCacheTableInternal() {
  await query(`
    CREATE TABLE IF NOT EXISTS preview_screenshot_cache (
      "id" serial PRIMARY KEY,
      "url" varchar(2048) NOT NULL UNIQUE,
      "file_name" varchar(255) NOT NULL UNIQUE,
      "file_path" varchar(1024) NOT NULL,
      "public_path" varchar(1024) NOT NULL,
      "created_at" timestamp NOT NULL DEFAULT now(),
      "last_accessed_at" timestamp NOT NULL DEFAULT now(),
      "expires_at" timestamp NOT NULL
    )
  `);

  await query(`
    ALTER TABLE preview_screenshot_cache
      ADD COLUMN IF NOT EXISTS url varchar(2048),
      ADD COLUMN IF NOT EXISTS file_name varchar(255),
      ADD COLUMN IF NOT EXISTS file_path varchar(1024),
      ADD COLUMN IF NOT EXISTS public_path varchar(1024),
      ADD COLUMN IF NOT EXISTS created_at timestamp NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS last_accessed_at timestamp NOT NULL DEFAULT now(),
      ADD COLUMN IF NOT EXISTS expires_at timestamp
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS preview_screenshot_cache_url_idx
    ON preview_screenshot_cache (url)
  `);

  await query(`
    CREATE UNIQUE INDEX IF NOT EXISTS preview_screenshot_cache_file_name_idx
    ON preview_screenshot_cache (file_name)
  `);

  await query(`
    CREATE INDEX IF NOT EXISTS preview_screenshot_cache_expires_at_idx
    ON preview_screenshot_cache (expires_at)
  `);
}

async function getPreviewCacheDurationMs() {
  const fallbackValue = constants.preview && constants.preview.screenshotCacheDurationMs
    ? constants.preview.screenshotCacheDurationMs
    : 1000 * 60 * 60 * 2;
  const configuredValue = await getAppConfig(PREVIEW_CACHE_CONFIG_KEY, fallbackValue);
  const parsedValue = Number(configuredValue);

  if (!Number.isFinite(parsedValue) || parsedValue <= 0) {
    return fallbackValue;
  }

  return Math.floor(parsedValue);
}

async function getPreviewPostNavigationDelayMs() {
  const fallbackValue = constants.preview && Number.isFinite(constants.preview.postNavigationDelayMs)
    ? constants.preview.postNavigationDelayMs
    : 150;
  const configuredValue = await getAppConfig(PREVIEW_POST_NAVIGATION_DELAY_CONFIG_KEY, fallbackValue);
  const parsedValue = Number(configuredValue);

  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    return fallbackValue;
  }

  return Math.floor(parsedValue);
}

async function getPreviewPostBannerDelayMs() {
  const fallbackValue = constants.preview && Number.isFinite(constants.preview.postBannerDelayMs)
    ? constants.preview.postBannerDelayMs
    : 250;
  const configuredValue = await getAppConfig(PREVIEW_POST_BANNER_DELAY_CONFIG_KEY, fallbackValue);
  const parsedValue = Number(configuredValue);

  if (!Number.isFinite(parsedValue) || parsedValue < 0) {
    return fallbackValue;
  }

  return Math.floor(parsedValue);
}

function getPreviewPublicPath(fileName) {
  return `/generated-previews/${fileName}`;
}

function safelyRemovePreviewArtifacts(filePath) {
  if (!filePath) {
    return;
  }

  try {
    fs.rmSync(filePath, { force: true });
  } catch (error) {
    console.warn('[preview] Failed to remove preview screenshot file', {
      filePath,
      error
    });
  }

  try {
    fs.rmSync(`${filePath}.json`, { force: true });
  } catch (error) {
    console.warn('[preview] Failed to remove legacy preview metadata file', {
      filePath,
      error
    });
  }
}

function removeLegacyPreviewMetadataFile(metadataPath) {
  try {
    fs.rmSync(metadataPath, { force: true });
  } catch (error) {
    console.warn('[preview] Failed to remove legacy preview metadata file', {
      metadataPath,
      error
    });
  }
}

function normalizePreviewCacheRow(row) {
  if (!row) {
    return null;
  }

  const fileName = row.file_name || (row.file_path ? path.basename(row.file_path) : null);
  return {
    ...row,
    file_name: fileName,
    public_path: row.public_path || (fileName ? getPreviewPublicPath(fileName) : null),
    created_at: row.created_at ? new Date(row.created_at) : null,
    last_accessed_at: row.last_accessed_at ? new Date(row.last_accessed_at) : null,
    expires_at: row.expires_at ? new Date(row.expires_at) : null
  };
}

function readLegacyPreviewMetadata(metadataPath) {
  try {
    const rawMetadata = fs.readFileSync(metadataPath, 'utf8');
    const parsedMetadata = JSON.parse(rawMetadata);

    return {
      url: parsedMetadata.url || null,
      imageUrl: parsedMetadata.imageUrl || null,
      createdAt: parsedMetadata.createdAt ? new Date(parsedMetadata.createdAt) : null,
      expiresAt: parsedMetadata.expiresAt ? new Date(parsedMetadata.expiresAt) : null
    };
  } catch (error) {
    console.warn('[preview] Failed to read legacy preview metadata file', {
      metadataPath,
      error
    });
    return null;
  }
}

async function ensureLegacyPreviewMetadataMigrated() {
  if (!previewLegacyMigrationPromise) {
    previewLegacyMigrationPromise = migrateLegacyPreviewMetadataFiles().catch((error) => {
      previewLegacyMigrationPromise = null;
      throw error;
    });
  }

  await previewLegacyMigrationPromise;
}

async function migrateLegacyPreviewMetadataFiles() {
  if (!fs.existsSync(PREVIEW_OUTPUT_DIR)) {
    return;
  }

  const fileNames = fs.readdirSync(PREVIEW_OUTPUT_DIR)
    .filter((fileName) => fileName.endsWith(`${PREVIEW_IMAGE_EXTENSION}.json`));

  for (const fileName of fileNames) {
    const metadataPath = path.join(PREVIEW_OUTPUT_DIR, fileName);
    const filePath = metadataPath.slice(0, -'.json'.length);
    const fileExists = fs.existsSync(filePath);
    const metadata = readLegacyPreviewMetadata(metadataPath);

    if (!fileExists || !metadata || !metadata.url) {
      removeLegacyPreviewMetadataFile(metadataPath);
      continue;
    }

    const createdAt = metadata.createdAt && Number.isFinite(metadata.createdAt.getTime())
      ? metadata.createdAt
      : new Date();
    const expiresAt = metadata.expiresAt && Number.isFinite(metadata.expiresAt.getTime())
      ? metadata.expiresAt
      : new Date(createdAt.getTime() + await getPreviewCacheDurationMs());

    await query(
      `INSERT INTO preview_screenshot_cache (
        url,
        file_name,
        file_path,
        public_path,
        created_at,
        last_accessed_at,
        expires_at
      ) VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (url) DO UPDATE SET
        file_name = EXCLUDED.file_name,
        file_path = EXCLUDED.file_path,
        public_path = EXCLUDED.public_path,
        created_at = EXCLUDED.created_at,
        last_accessed_at = EXCLUDED.last_accessed_at,
        expires_at = EXCLUDED.expires_at`,
      [
        metadata.url,
        path.basename(filePath),
        filePath,
        metadata.imageUrl || getPreviewPublicPath(path.basename(filePath)),
        createdAt,
        createdAt,
        expiresAt
      ]
    );

    removeLegacyPreviewMetadataFile(metadataPath);
  }
}

async function getPreviewCacheEntryByUrl(url) {
  await ensurePreviewCacheTable();
  const result = await query(
    `SELECT *
     FROM preview_screenshot_cache
     WHERE url = $1
     LIMIT 1`,
    [url]
  );

  return normalizePreviewCacheRow(result.rows[0] || null);
}

async function deletePreviewCacheEntry(entry, options = {}) {
  if (!entry || !entry.id) {
    return;
  }

  await ensurePreviewCacheTable();

  if (options.deleteFile !== false) {
    safelyRemovePreviewArtifacts(entry.file_path);
  }

  await query(
    `DELETE FROM preview_screenshot_cache
     WHERE id = $1`,
    [entry.id]
  );
}

async function touchPreviewCacheEntry(entry) {
  if (!entry || !entry.id) {
    return null;
  }

  const expiresAt = new Date(Date.now() + await getPreviewCacheDurationMs());
  const touchedAt = new Date();

  const result = await query(
    `UPDATE preview_screenshot_cache
     SET last_accessed_at = $2,
         expires_at = $3
     WHERE id = $1
     RETURNING *`,
    [entry.id, touchedAt, expiresAt]
  );

  return normalizePreviewCacheRow(result.rows[0] || null);
}

async function upsertPreviewCacheEntry({ url, fileName, filePath, publicPath, createdAt }) {
  await ensurePreviewCacheTable();

  const existingEntry = await getPreviewCacheEntryByUrl(url);
  const cacheDurationMs = await getPreviewCacheDurationMs();
  const normalizedCreatedAt = createdAt || new Date();
  const lastAccessedAt = normalizedCreatedAt;
  const expiresAt = new Date(normalizedCreatedAt.getTime() + cacheDurationMs);

  const result = await query(
    `INSERT INTO preview_screenshot_cache (
      url,
      file_name,
      file_path,
      public_path,
      created_at,
      last_accessed_at,
      expires_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7)
    ON CONFLICT (url) DO UPDATE SET
      file_name = EXCLUDED.file_name,
      file_path = EXCLUDED.file_path,
      public_path = EXCLUDED.public_path,
      created_at = EXCLUDED.created_at,
      last_accessed_at = EXCLUDED.last_accessed_at,
      expires_at = EXCLUDED.expires_at
    RETURNING *`,
    [url, fileName, filePath, publicPath, normalizedCreatedAt, lastAccessedAt, expiresAt]
  );

  if (existingEntry && existingEntry.file_path && existingEntry.file_path !== filePath) {
    safelyRemovePreviewArtifacts(existingEntry.file_path);
  }

  return normalizePreviewCacheRow(result.rows[0] || null);
}

function updatePrices(options = {}) {
  const startedAt = Date.now();
  console.info('[crawler] Update job started');
  return getAndUpdatePrices(options).catch((error) => {
    console.error('[crawler] Update job failed', {
      durationMs: Date.now() - startedAt,
      error
    });
    return {
      runId: null,
      summary: {
        status: 'failed',
        errorMessage: error && error.message ? error.message : 'Crawler update failed'
      }
    };
  });
}

async function getAndUpdatePrices(options = {}) {
  const runStartedAt = new Date();
  const run = await createCrawlerRun({
    trigger_type: options.triggerType || 'scheduled',
    triggered_by_user_id: options.triggeredBy && options.triggeredBy.id,
    triggered_by_email: options.triggeredBy && options.triggeredBy.email,
    status: 'running',
    started_at: runStartedAt
  });

  const summary = createRunSummary(runStartedAt);
  let processedTracks = false;

  try {
    await ensureTrackSoftDeleteColumn();
    const result = await query(
      `SELECT *
       FROM track
       WHERE active = TRUE
         AND deleted = FALSE`
    );
    processedTracks = true;
    console.info('[crawler] Loaded tracks for update', {
      runId: run.id,
      trackCount: result.rows.length
    });

    for (let i = 0; i < result.rows.length; i++) {
      const track = result.rows[i];
      let itemResult = null;

      try {
        itemResult = await processTrackUpdate(track, run.id);

        const insertedItem = await insertCrawlerRunItem({
          run_id: run.id,
          track_id: track.id,
          user_id: track.user_id,
          product_name: track.product_name,
          product_url: track.price_url,
          requires_javascript: track.requires_javascript,
          status: itemResult.status,
          stage: itemResult.stage,
          html_lookup_success: itemResult.htmlLookupSuccess,
          previous_price: itemResult.previousPrice,
          current_price: itemResult.currentPrice,
          price_direction: itemResult.priceDirection,
          marked_inactive: itemResult.markedInactive,
          reactivated: itemResult.reactivated,
          failure_log_id: itemResult.failureLogId,
          error_message: itemResult.errorMessage,
          duration_ms: itemResult.durationMs
        });

        if (itemResult.failureLogId) {
          await updateCrawlerFailureLogLinks(itemResult.failureLogId, {
            run_id: run.id,
            run_item_id: insertedItem.id
          });
        }
      } catch (error) {
        console.error('[crawler] Track processing pipeline failed unexpectedly', {
          runId: run.id,
          trackId: track.id,
          url: track.price_url,
          error
        });
        itemResult = await handleUnexpectedTrackError(track, run.id, error, itemResult);
      }

      applyRunItemToSummary(summary, itemResult);
    }

    summary.status = summary.error_count > 0 ? 'partial' : 'success';
  } catch (error) {
    summary.status = 'failed';
    summary.error_count += 1;
    console.error('[crawler] Update job query failed', {
      runId: run.id,
      error
    });
  } finally {
    summary.finished_at = new Date();
    summary.duration_ms = summary.finished_at.getTime() - summary.started_at.getTime();
    summary.track_count = summary.track_count || 0;
    try {
      await finalizeCrawlerRun(run.id, summary);
      console.info('[crawler] Update job finished', {
        runId: run.id,
        status: summary.status,
        trackCount: summary.track_count,
        updatedCount: summary.updated_count,
        unchangedCount: summary.unchanged_count,
        errorCount: summary.error_count,
        durationMs: summary.duration_ms
      });
    } catch (finalizeError) {
      console.error('[crawler] Failed to finalize crawler run', {
        runId: run.id,
        status: summary.status,
        error: finalizeError
      });
    }
  }

  return {
    runId: run.id,
    summary
  };
}

async function updateSingleTrack(track, options = {}) {
  const runStartedAt = new Date();
  const run = await createCrawlerRun({
    trigger_type: options.triggerType || 'manual-single',
    triggered_by_user_id: options.triggeredBy && options.triggeredBy.id,
    triggered_by_email: options.triggeredBy && options.triggeredBy.email,
    status: 'running',
    started_at: runStartedAt
  });

  const summary = createRunSummary(runStartedAt);
  let itemResult = null;
  let trackProcessed = false;

  try {
    itemResult = await processTrackUpdate(track, run.id);
    trackProcessed = true;

    const insertedItem = await insertCrawlerRunItem({
      run_id: run.id,
      track_id: track.id,
      user_id: track.user_id,
      product_name: track.product_name,
      product_url: track.price_url,
      requires_javascript: track.requires_javascript,
      status: itemResult.status,
      stage: itemResult.stage,
      html_lookup_success: itemResult.htmlLookupSuccess,
      previous_price: itemResult.previousPrice,
      current_price: itemResult.currentPrice,
      price_direction: itemResult.priceDirection,
      marked_inactive: itemResult.markedInactive,
      reactivated: itemResult.reactivated,
      failure_log_id: itemResult.failureLogId,
      error_message: itemResult.errorMessage,
      duration_ms: itemResult.durationMs
    });

    if (itemResult.failureLogId) {
      await updateCrawlerFailureLogLinks(itemResult.failureLogId, {
        run_id: run.id,
        run_item_id: insertedItem.id
      });
    }
  } catch (error) {
    console.error('[crawler] Single-track processing pipeline failed unexpectedly', {
      runId: run.id,
      trackId: track.id,
      url: track.price_url,
      error
    });
    itemResult = await handleUnexpectedTrackError(track, run.id, error, itemResult);
    trackProcessed = true;
  } finally {
    applyRunItemToSummary(summary, itemResult || createRunItemResult(track));
    summary.status = summary.error_count > 0 ? 'partial' : 'success';
    summary.finished_at = new Date();
    summary.duration_ms = summary.finished_at.getTime() - summary.started_at.getTime();

    try {
      await finalizeCrawlerRun(run.id, summary);
    } catch (finalizeError) {
      console.error('[crawler] Failed to finalize single-track crawler run', {
        runId: run.id,
        error: finalizeError
      });
    }
  }

  return {
    runId: run.id,
    itemResult
  };
}

async function getTrackHtmlPreview(track) {
  const trackContext = {
    ...track,
    action: 'preview-html'
  };

  if (track.requires_javascript) {
    return getRenderedHTML(trackContext);
  }

  return getHTML(trackContext);
}

async function getUrlPreview(inputUrl) {
  const normalizedUrl = normalizePreviewUrl(inputUrl);
  const iframeDecision = await inspectIframeSupport(normalizedUrl);

  if (iframeDecision.mode === 'iframe') {
    return {
      mode: 'iframe',
      url: iframeDecision.url
    };
  }

  const imageUrl = await capturePreviewScreenshot(iframeDecision.url);
  return {
    mode: 'screenshot',
    url: iframeDecision.url,
    imageUrl,
    reason: iframeDecision.reason
  };
}

function getRandomUserAgent() {
  const userAgents = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36',
    'Mozilla/5.0 (X11; Linux x86_64; rv:107.0) Gecko/20100101 Firefox/107.0',
    'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/15.0 Mobile/15E148 Safari/604.1',
    'Mozilla/5.0 (Windows NT 10.0; WOW64; rv:45.0) Gecko/20100101 Firefox/45.0'
  ];
  return userAgents[Math.floor(Math.random() * userAgents.length)];
}

function normalizePreviewUrl(inputUrl) {
  let parsedUrl;

  try {
    parsedUrl = new URL(String(inputUrl || '').trim());
  } catch (error) {
    const invalidUrlError = new Error('Enter a valid http(s) URL');
    invalidUrlError.code = 'INVALID_PREVIEW_URL';
    throw invalidUrlError;
  }

  if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
    const invalidProtocolError = new Error('Preview URL must use http or https');
    invalidProtocolError.code = 'INVALID_PREVIEW_URL';
    throw invalidProtocolError;
  }

  const hostname = parsedUrl.hostname.toLowerCase();
  if (hostname === 'localhost' || hostname.endsWith('.local') || isPrivateHostname(hostname)) {
    const blockedHostError = new Error('Preview URL host is not allowed');
    blockedHostError.code = 'INVALID_PREVIEW_URL';
    throw blockedHostError;
  }

  return parsedUrl.toString();
}

function isPrivateHostname(hostname) {
  if (!hostname) {
    return true;
  }

  if (hostname === '::1' || hostname === '[::1]') {
    return true;
  }

  const normalizedHost = hostname.replace(/^\[|\]$/g, '');
  if (/^\d+\.\d+\.\d+\.\d+$/.test(normalizedHost)) {
    const parts = normalizedHost.split('.').map((value) => Number.parseInt(value, 10));
    if (parts.some((value) => !Number.isInteger(value) || value < 0 || value > 255)) {
      return true;
    }

    return (
      parts[0] === 10 ||
      parts[0] === 127 ||
      (parts[0] === 169 && parts[1] === 254) ||
      (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) ||
      (parts[0] === 192 && parts[1] === 168)
    );
  }

  return (
    normalizedHost.startsWith('fc') ||
    normalizedHost.startsWith('fd') ||
    normalizedHost.startsWith('fe80:') ||
    normalizedHost.startsWith('::ffff:127.')
  );
}

async function inspectIframeSupport(url) {
  let response = null;

  try {
    response = await fetch(url, {
      method: 'HEAD',
      redirect: 'follow',
      headers: {
        'User-Agent': getRandomUserAgent()
      }
    });

    if (!response.ok || response.status === 405 || response.status === 501) {
      if (response.body && typeof response.body.destroy === 'function') {
        response.body.destroy();
      }

      response = await fetch(url, {
        method: 'GET',
        redirect: 'follow',
        headers: {
          'User-Agent': getRandomUserAgent()
        }
      });
    }

    const finalUrl = response.url || url;
    const xFrameOptions = response.headers.get('x-frame-options');
    const contentSecurityPolicy = response.headers.get('content-security-policy');

    if (response.body && typeof response.body.destroy === 'function') {
      response.body.destroy();
    }

    if (isIframeBlockedByHeaders(xFrameOptions, contentSecurityPolicy)) {
      return {
        mode: 'screenshot',
        url: finalUrl,
        reason: 'iframe_blocked'
      };
    }

    return {
      mode: 'iframe',
      url: finalUrl,
      reason: null
    };
  } catch (error) {
    console.warn('[preview] Failed to inspect iframe support, defaulting to iframe preview', {
      url,
      error
    });

    if (response && response.body && typeof response.body.destroy === 'function') {
      response.body.destroy();
    }

    return {
      mode: 'iframe',
      url,
      reason: 'inspection_failed'
    };
  }
}

function isIframeBlockedByHeaders(xFrameOptions, contentSecurityPolicy) {
  const normalizedXFrameOptions = String(xFrameOptions || '').trim().toLowerCase();
  if (normalizedXFrameOptions.includes('deny') || normalizedXFrameOptions.includes('sameorigin')) {
    return true;
  }

  const frameAncestorsValue = extractFrameAncestorsValue(contentSecurityPolicy);
  if (!frameAncestorsValue) {
    return false;
  }

  const normalizedFrameAncestors = frameAncestorsValue.toLowerCase();
  if (normalizedFrameAncestors.includes("'none'") || normalizedFrameAncestors.includes("'self'")) {
    return true;
  }

  return !normalizedFrameAncestors.includes('*');
}

function extractFrameAncestorsValue(contentSecurityPolicy) {
  const policy = String(contentSecurityPolicy || '');
  const match = policy.match(/frame-ancestors\s+([^;]+)/i);
  return match ? match[1].trim() : '';
}

async function capturePreviewScreenshot(url) {
  await maybeCleanupOldPreviewFiles();

  const cachedPreview = await getCachedPreviewScreenshot(url);
  if (cachedPreview) {
    return cachedPreview;
  }

  const inflightCapture = previewScreenshotInflight.get(url);
  if (inflightCapture) {
    return inflightCapture;
  }

  const capturePromise = (async () => {
    fs.mkdirSync(PREVIEW_OUTPUT_DIR, { recursive: true });

    const fileName = `preview_${Date.now()}_${Math.random().toString(36).slice(2, 10)}.png`;
    const outputPath = path.join(PREVIEW_OUTPUT_DIR, fileName);
    const browser = await getPreviewBrowser();
    const page = await browser.newPage();

    try {
      await page.setViewport(PREVIEW_VIEWPORT);
      await page.setUserAgent(getRandomUserAgent());
      await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: PREVIEW_TIMEOUT_MS
      });

      await delay(await getPreviewPostNavigationDelayMs());
      await dismissCookieBanners(page);
      await page.screenshot({
        path: outputPath,
        type: 'png',
        fullPage: false
      });

      const createdAt = new Date();
      const publicPath = getPreviewPublicPath(fileName);
      await upsertPreviewCacheEntry({
        url,
        fileName,
        filePath: outputPath,
        publicPath,
        createdAt
      });

      console.info('[preview] Screenshot captured', { url, fileName });
      return publicPath;
    } finally {
      await page.close().catch(() => null);
    }
  })();

  previewScreenshotInflight.set(url, capturePromise);

  try {
    return await capturePromise;
  } finally {
    previewScreenshotInflight.delete(url);
  }
}

async function dismissCookieBanners(page) {
  const frames = page.frames();
  let clickedBanner = false;

  for (const frame of frames) {
    const clicked = await dismissCookieBannerInFrame(frame);
    clickedBanner = clickedBanner || clicked;
  }

  if (clickedBanner) {
    await delay(await getPreviewPostBannerDelayMs());
  }

  for (const frame of page.frames()) {
    await hideCookieOverlayInFrame(frame);
  }
}

async function dismissCookieBannerInFrame(frame) {
  const selectorGroups = [
    [
      '#onetrust-reject-all-handler',
      '#onetrust-pc-btn-handler',
      '[data-testid*="reject"]',
      '[id*="reject"]',
      '[class*="reject"]'
    ],
    [
      '[data-testid*="necessary"]',
      '[id*="necessary"]',
      '[class*="necessary"]',
      '[aria-label*="necessary"]'
    ],
    [
      '#onetrust-close-btn-container button',
      '.onetrust-close-btn-handler',
      '[aria-label="Close"]',
      '[aria-label="Dismiss"]',
      '[data-testid*="close"]'
    ],
    [
      '#onetrust-accept-btn-handler',
      '[data-testid*="accept"]',
      '[id*="accept"]',
      '[class*="accept"]'
    ]
  ];

  for (const selectors of selectorGroups) {
    for (const selector of selectors) {
      try {
        const handle = await frame.$(selector);
        if (handle) {
          await handle.click({ delay: 40 });
          return true;
        }
      } catch (error) {
        // Try the next selector.
      }
    }
  }

  try {
    return await frame.evaluate((preferredTexts) => {
      const normalize = (value) => String(value || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();

      const clickables = Array.from(
        document.querySelectorAll('button, a, [role="button"], input[type="button"], input[type="submit"]')
      );

      for (const preferredText of preferredTexts) {
        const match = clickables.find((element) => {
          const label = normalize(
            element.innerText ||
            element.textContent ||
            element.value ||
            element.getAttribute('aria-label')
          );

          return label && (label === preferredText || label.includes(preferredText));
        });

        if (match) {
          match.click();
          return true;
        }
      }

      return false;
    }, [
      'reject all',
      'only necessary',
      'necessary only',
      'continue without accepting',
      'reject',
      'hafna',
      'leyfa nauðsynlegar',
      'bara nauðsynlegar',
      'close',
      'dismiss',
      'loka',
      'got it',
      'accept',
      'accept all',
      'allow all',
      'i agree',
      'agree',
      'leyfa vafrakökur',
      'samþykkja vafrakökur',
      'samþykkja',
      'leyfa allar'
    ]);
  } catch (error) {
    return false;
  }
}

async function hideCookieOverlayInFrame(frame) {
  try {
    await frame.evaluate((keywords) => {
      const normalize = (value) => String(value || '')
        .trim()
        .replace(/\s+/g, ' ')
        .toLowerCase();

      const keywordList = keywords.map((keyword) => keyword.toLowerCase());
      const elements = Array.from(document.querySelectorAll('body *'));

      for (const element of elements) {
        const descriptor = normalize([
          element.id,
          element.className,
          element.getAttribute('aria-label'),
          element.getAttribute('data-testid'),
          element.getAttribute('role')
        ].join(' '));

        const style = window.getComputedStyle(element);
        const isFixed = style.position === 'fixed' || style.position === 'sticky';
        const coversLargeArea =
          element.offsetWidth >= window.innerWidth * 0.6 &&
          element.offsetHeight >= window.innerHeight * 0.15;
        const keywordMatch = keywordList.some((keyword) => descriptor.includes(keyword));

        if (keywordMatch && isFixed && coversLargeArea) {
          element.style.setProperty('display', 'none', 'important');
          element.style.setProperty('visibility', 'hidden', 'important');
          element.style.setProperty('pointer-events', 'none', 'important');
        }
      }

      document.documentElement.style.overflow = 'auto';
      document.body.style.overflow = 'auto';
    }, [
      'cookie',
      'consent',
      'gdpr',
      'privacy',
      'onetrust',
      'cookiebot',
      'trustarc',
      'quantcast',
      'usercentrics',
      'didomi'
    ]);
  } catch (error) {
    // Ignore per-frame cleanup failures.
  }
}

async function getCachedPreviewScreenshot(url) {
  const cachedEntry = await getPreviewCacheEntryByUrl(url);
  if (!cachedEntry) {
    return null;
  }

  const fileExists = cachedEntry.file_path && fs.existsSync(cachedEntry.file_path);
  if (!fileExists) {
    await deletePreviewCacheEntry(cachedEntry, {
      deleteFile: false
    });
    return null;
  }

  if (!cachedEntry.expires_at || cachedEntry.expires_at.getTime() <= Date.now()) {
    await deletePreviewCacheEntry(cachedEntry);
    return null;
  }

  const refreshedEntry = await touchPreviewCacheEntry(cachedEntry);
  return refreshedEntry ? refreshedEntry.public_path : cachedEntry.public_path;
}

async function maybeCleanupOldPreviewFiles() {
  if (Date.now() - lastPreviewCleanupAt < PREVIEW_CLEANUP_INTERVAL_MS) {
    return;
  }

  lastPreviewCleanupAt = Date.now();
  await cleanupOldPreviewFiles();
}

async function cleanupOldPreviewFiles() {
  await ensurePreviewCacheTable();

  const summary = {
    deletedCount: 0,
    retainedCount: 0,
    missingFileCount: 0,
    orphanFileCount: 0,
    legacyMetadataFilesRemoved: 0
  };

  const now = Date.now();
  const result = await query(
    `SELECT *
     FROM preview_screenshot_cache
     ORDER BY created_at ASC`
  );
  const cacheEntries = result.rows.map((row) => normalizePreviewCacheRow(row));
  const referencedFiles = new Set();

  for (const entry of cacheEntries) {
    const fileExists = entry.file_path && fs.existsSync(entry.file_path);
    const isExpired = !entry.expires_at || entry.expires_at.getTime() <= now;

    if (!fileExists) {
      await deletePreviewCacheEntry(entry, {
        deleteFile: false
      });
      summary.missingFileCount += 1;
      continue;
    }

    if (isExpired) {
      await deletePreviewCacheEntry(entry);
      summary.deletedCount += 1;
      continue;
    }

    if (entry.file_path) {
      referencedFiles.add(entry.file_path);
    }
    summary.retainedCount += 1;
  }

  if (!fs.existsSync(PREVIEW_OUTPUT_DIR)) {
    return summary;
  }

  const fileNames = fs.readdirSync(PREVIEW_OUTPUT_DIR);
  for (const fileName of fileNames) {
    const absolutePath = path.join(PREVIEW_OUTPUT_DIR, fileName);

    if (fileName.endsWith(`${PREVIEW_IMAGE_EXTENSION}.json`)) {
      removeLegacyPreviewMetadataFile(absolutePath);
      summary.legacyMetadataFilesRemoved += 1;
      continue;
    }

    if (!fileName.endsWith(PREVIEW_IMAGE_EXTENSION)) {
      continue;
    }

    if (referencedFiles.has(absolutePath)) {
      continue;
    }

    try {
      const stats = fs.statSync(absolutePath);
      if (now - stats.mtimeMs < PREVIEW_ORPHAN_GRACE_MS) {
        continue;
      }

      safelyRemovePreviewArtifacts(absolutePath);
      summary.orphanFileCount += 1;
    } catch (error) {
      console.warn('[preview] Failed to inspect orphan preview file', {
        fileName,
        error
      });
    }
  }

  return summary;
}

function delay(durationMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

async function getPreviewBrowser() {
  if (!previewBrowserPromise) {
    previewBrowserPromise = puppeteer.launch().then((browser) => {
      browser.on('disconnected', () => {
        previewBrowserPromise = null;
      });
      return browser;
    }).catch((error) => {
      previewBrowserPromise = null;
      throw error;
    });
  }

  return previewBrowserPromise;
}

async function cleanupStoredPreviewFiles() {
  lastPreviewCleanupAt = Date.now();
  const summary = await cleanupOldPreviewFiles();
  if (
    Number(summary.deletedCount || 0) > 0 ||
    Number(summary.missingFileCount || 0) > 0 ||
    Number(summary.orphanFileCount || 0) > 0 ||
    Number(summary.legacyMetadataFilesRemoved || 0) > 0
  ) {
    console.info('[preview] Stored preview cleanup completed', summary);
  }
  return summary;
}

async function getPreviewCacheSummary() {
  await maybeCleanupOldPreviewFiles();
  await ensurePreviewCacheTable();

  const result = await query(
    `SELECT *
     FROM preview_screenshot_cache
     ORDER BY created_at DESC`
  );

  const screenshotFiles = result.rows
    .map((row) => normalizePreviewCacheRow(row))
    .map((entry) => {
      const fileExists = entry.file_path && fs.existsSync(entry.file_path);
      let sizeBytes = null;

      if (fileExists) {
        try {
          sizeBytes = fs.statSync(entry.file_path).size;
        } catch (error) {
          console.warn('[preview] Failed to inspect cached screenshot file', {
            filePath: entry.file_path,
            error
          });
        }
      }

      return {
        id: entry.id,
        fileName: entry.file_name,
        publicPath: entry.public_path,
        absolutePath: entry.file_path,
        sourceUrl: entry.url,
        createdAt: entry.created_at,
        lastAccessedAt: entry.last_accessed_at,
        estimatedClearAt: entry.expires_at,
        sizeBytes,
        fileExists
      };
    });

  return {
    screenshotDirectory: PREVIEW_OUTPUT_DIR,
    screenshotFiles
  };
}

async function getHTML(url) {
  const target = typeof url === 'string' ? { price_url: url } : url;
  let attempts = 0;
  let lastError = null;
  let finalFailureDetails = null;

  while (attempts < 3) {
    try {
      const randomUserAgent = getRandomUserAgent();
      const settings = {
        headers: {
          'User-Agent': randomUserAgent
        }
      };

      const response = await fetch(target.price_url, settings);

      if (!response.ok) {
        const responseHtml = await response.text();

        const error = new Error(`HTTP error! Status: ${response.status}`);
        error.details = {
          url: target.price_url,
          status: response.status,
          userAgent: randomUserAgent
        };
        finalFailureDetails = {
          responseHtml,
          status: response.status,
          userAgent: randomUserAgent
        };
        throw error;
      }

      const html = await response.text();

      if (!html) {
        throw new Error('Empty HTML content');
      }

      return html; // Return the successfully fetched HTML
    } catch (error) {
      attempts++;
      lastError = error;
      console.warn('[crawler] HTML fetch attempt failed', {
        url: target.price_url,
        attempt: attempts,
        error
      });
    }
  }

  let htmlFilePath = null;
  if (finalFailureDetails && finalFailureDetails.responseHtml && await shouldSaveHtml(getActionName(target), true)) {
    htmlFilePath = saveHTMLFile(finalFailureDetails.responseHtml, {
      action: getActionName(target),
      trackId: target.id,
      userId: target.user_id,
      url: target.price_url,
      suffix: 'fetch-failed'
    });
  }

  const failureLogId = await logCrawlerFailure(target, 'fetch-html', lastError, {
    htmlFilePath,
    status: finalFailureDetails ? finalFailureDetails.status : null,
    userAgent: finalFailureDetails ? finalFailureDetails.userAgent : null
  });
  const finalError = new Error(`Failed to fetch HTML after 3 attempts: ${lastError.message}`);
  finalError.details = {
    ...(lastError && lastError.details ? lastError.details : {}),
    failureLogId,
    stage: 'fetch-html'
  };
  throw finalError;
}

async function getRenderedHTML(url) {
  const target = typeof url === 'string' ? { price_url: url } : url;
  // Launch a headless browser
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  let attempts = 0;
  let lastError = null;

  try {
    while (attempts < 3) {
      const randomUserAgent = getRandomUserAgent();

      try {
        // Set user agent
        await page.setUserAgent(randomUserAgent);

        // Navigate to the page
        await page.goto(target.price_url, {
            waitUntil: 'networkidle2', // Wait until all network requests are finished
        });
      
        // Extract the fully rendered HTML
        const html = await page.content();

        if (!html) {
          throw new Error('Empty HTML content');
        }

        return html;
      } catch (error) {
        attempts++;
        lastError = error;
        console.warn('[crawler] Rendered HTML fetch attempt failed', {
          url: target.price_url,
          attempt: attempts,
          error
        });
      }
    }

    const failureLogId = await logCrawlerFailure(target, 'render-html', lastError, {});
    if (lastError && lastError.details) {
      lastError.details.failureLogId = failureLogId;
      lastError.details.stage = 'render-html';
    } else if (lastError) {
      lastError.details = {
        failureLogId,
        stage: 'render-html'
      };
    }
    const finalError = new Error(`Failed to fetch HTML after 3 attempts: ${lastError.message}`);
    finalError.details = {
      ...(lastError && lastError.details ? lastError.details : {}),
      failureLogId,
      stage: 'render-html'
    };
    throw finalError;
  } finally {
    await browser.close();
  }
}

function saveHTMLFile(html, metadata) {
  const fileName = buildHtmlFilePath(metadata);
  fs.mkdirSync(path.dirname(fileName), { recursive: true });
  fs.writeFile(fileName, html, function(err) {
    if (err) {
      console.error('[crawler] Failed to save HTML file', {
        fileName,
        action: metadata.action,
        trackId: metadata.trackId || null,
        error: err
      });
      return;
    }
    console.info('[crawler] HTML file saved', {
      fileName,
      action: metadata.action,
      trackId: metadata.trackId || null
    });
  });
  return fileName;
}

async function findPriceFromDiv(html, track) {
  const jsonLdPrice = extractPriceFromJsonLd(html);
  if (isValidMatchedPrice(jsonLdPrice)) {
    return handleMatchedPrice(jsonLdPrice, track);
  }

  if (trackUsesNextDataPriceDiv(track)) {
    const nextDataPrice = extractPriceFromNextData(html);
    if (isValidMatchedPrice(nextDataPrice)) {
      return handleMatchedPrice(nextDataPrice, track);
    }
  }

  let priceDivBeforeAfter = [];
  const htmlMinMatchSize = await getAppConfig('crawler.html_min_match_size', constants.crawler.htmlMinMatchSize);
  const trackPriceDiv = stripPriceDivSourcePrefix(track.price_div);

  // Try to find exact match
  let matches = html.match(trackPriceDiv);

  // If exact match failes then try matching html before price, then after price
  // This can happen when price is discounted and a before price or a discount percentage div is added
  if (!matches || !matches[1]) {
    priceDivBeforeAfter = trackPriceDiv.split("(.*?)");
    let searchString = `${priceDivBeforeAfter[0]}(.*?)<`;
    matches = html.match(searchString);
  }
  if (!matches || !matches[1]) {
    matches = findHTMLSubstringRight(html, priceDivBeforeAfter[1]);
  }
  // If matching full before and after price html then try only the closest portion
  if (!matches || !matches[1]) {
    let searchString = `${priceDivBeforeAfter[0].slice(-htmlMinMatchSize)}(.*?)<`;
    matches = html.match(searchString);
  }
  if (!matches || !matches[1]) {
    matches = findHTMLSubstringRight(html, priceDivBeforeAfter[1].substring(1, htmlMinMatchSize));
  }

  // If match is not found or match is over 500 characters long
  if (!matches || !matches[1] || matches[1].length >= 500) { 
    let htmlFilePath = null;
    if (await shouldSaveHtml('update', true)) {
      htmlFilePath = saveHTMLFile(html, {
        action: 'update',
        trackId: track.id,
        userId: track.user_id,
        url: track.price_url,
        suffix: 'match-failed'
      });
    }

    console.warn('[crawler] Price match not found, marking track inactive', {
      id: track.id,
      url: track.price_url
    });
    const failureLogId = await logCrawlerFailure(track, 'find-price', new Error('Price match not found'), {
      htmlFilePath,
      matchLength: matches && matches[1] ? matches[1].length : null
    });
    const inactiveEmailDurationMs = await setTrackAsInactive(track);
    return {
      status: 'match_failed',
      stage: 'find-price',
      previousPrice: track.curr_price,
      currentPrice: null,
      priceDirection: null,
      markedInactive: true,
      reactivated: false,
      failureLogId,
      errorMessage: 'Price match not found',
      emailDurationMs: inactiveEmailDurationMs
    };
  } 

  // If numer has more than 20 digits then something went wrong in matching
  let match = extractNumber(matches[1]);
  if (!isValidMatchedPrice(match)) {
    match = ''; 
  }
  if (isNumeric(match)) {
    return handleMatchedPrice(match, track);
  } else {
    let htmlFilePath = null;
    if (await shouldSaveHtml('update', true)) {
      htmlFilePath = saveHTMLFile(html, {
        action: 'update',
        trackId: track.id,
        userId: track.user_id,
        url: track.price_url,
        suffix: 'non-numeric-match'
      });
    }

    console.warn('[crawler] Extracted match was not numeric, marking track inactive', {
      id: track.id,
      rawMatch: matches[1]
    });
    const failureLogId = await logCrawlerFailure(track, 'find-price', new Error('Extracted match was not numeric'), {
      htmlFilePath,
      rawMatch: matches[1]
    });
    const inactiveEmailDurationMs = await setTrackAsInactive(track);
    return {
      status: 'non_numeric_match',
      stage: 'find-price',
      previousPrice: track.curr_price,
      currentPrice: null,
      priceDirection: null,
      markedInactive: true,
      reactivated: false,
      failureLogId,
      errorMessage: 'Extracted match was not numeric',
      emailDurationMs: inactiveEmailDurationMs
    };
  }
};

async function handleMatchedPrice(match, track) {
  // If tracked price has changed we update database and send email to user
  if (match !== track.curr_price) {
    await updatePrice(match, track);
    const priceDirection = Number(match) < Number(track.curr_price)
      ? 'lower'
      : Number(match) > Number(track.curr_price)
        ? 'higher'
        : 'same';
    console.info('[crawler] Price changed', {
      id: track.id,
      productName: track.product_name,
      previousPrice: track.curr_price,
      newPrice: match
    });

    // Update track object with new price before sending email
    const previousPrice = track.curr_price;
    track.curr_price = match;
    const emailDurationMs = await sendPriceUpdateEmail(track, {
      previousPrice
    });
    return {
      status: priceDirection === 'lower' ? 'updated_lower' : priceDirection === 'higher' ? 'updated_higher' : 'updated_other',
      stage: 'find-price',
      previousPrice,
      currentPrice: match,
      priceDirection,
      markedInactive: false,
      reactivated: false,
      failureLogId: null,
      errorMessage: null,
      emailDurationMs
    };
  }
  if (!track.active) {
    await setTrackAsActive(track);
    console.info('[crawler] Track reactivated', {
      id: track.id
    });
    return {
      status: 'reactivated',
      stage: 'find-price',
      previousPrice: track.curr_price,
      currentPrice: match,
      priceDirection: 'same',
      markedInactive: false,
      reactivated: true,
      failureLogId: null,
      errorMessage: null
    };
  }

  return {
    status: 'unchanged',
    stage: 'find-price',
    previousPrice: track.curr_price,
    currentPrice: match,
    priceDirection: 'same',
    markedInactive: false,
    reactivated: false,
    failureLogId: null,
    errorMessage: null
  };
}

function extractPriceFromJsonLd(html) {
  const productData = extractProductDataFromJsonLd(html);
  return productData ? productData.price : null;
}

const NEXT_DATA_PRICE_DIV_PREFIX = '__NEXT_DATA__::';

function extractPriceFromNextData(html) {
  const productData = extractProductDataFromNextData(html);
  return productData ? productData.price : null;
}

function trackUsesNextDataPriceDiv(track) {
  return track != null
    && typeof track.price_div === 'string'
    && track.price_div.startsWith(NEXT_DATA_PRICE_DIV_PREFIX);
}

function stripPriceDivSourcePrefix(priceDiv) {
  if (typeof priceDiv !== 'string') {
    return priceDiv;
  }

  if (priceDiv.startsWith(NEXT_DATA_PRICE_DIV_PREFIX)) {
    return priceDiv.slice(NEXT_DATA_PRICE_DIV_PREFIX.length);
  }

  return priceDiv;
}

function safeParseJson(value) {
  try {
    return JSON.parse(value);
  } catch (error) {
    return null;
  }
}

function extractProductDataFromJsonLd(html) {
  const scriptMatches = html.match(/<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi) || [];

  for (const scriptTag of scriptMatches) {
    const contentMatch = scriptTag.match(/<script[^>]*>([\s\S]*?)<\/script>/i);
    if (!contentMatch || !contentMatch[1]) {
      continue;
    }

    const scriptContent = contentMatch[1].trim();
    const parsedJson = safeParseJson(scriptContent);
    if (parsedJson == null) {
      continue;
    }

    const productData = findProductDataInJsonLd(parsedJson);
    if (productData && isNumeric(productData.price)) {
      return {
        ...productData,
        priceDiv: buildJsonLdPriceDiv(scriptContent, productData.price)
      };
    }
  }

  return null;
}

function extractProductDataFromNextData(html) {
  const scriptMatch = html.match(/<script(?=[^>]*id=["']__NEXT_DATA__["'])(?=[^>]*type=["']application\/json["'])[^>]*>([\s\S]*?)<\/script>/i);
  if (!scriptMatch || !scriptMatch[1]) {
    return null;
  }

  const scriptContent = scriptMatch[1].trim();
  const parsedJson = safeParseJson(scriptContent);
  if (parsedJson == null) {
    return null;
  }

  const productData = findProductDataInNextData(parsedJson);
  if (!productData || !isNumeric(productData.price)) {
    return null;
  }

  return {
    ...productData,
    priceDiv: buildNextDataPriceDiv(scriptContent, productData.price)
  };
}

function findProductDataInJsonLd(node) {
  if (!node) {
    return null;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const productData = findProductDataInJsonLd(item);
      if (productData) {
        return productData;
      }
    }
    return null;
  }

  if (typeof node !== 'object') {
    return null;
  }

  if (node['@graph']) {
    const graphProductData = findProductDataInJsonLd(node['@graph']);
    if (graphProductData) {
      return graphProductData;
    }
  }

  const typeValue = Array.isArray(node['@type']) ? node['@type'] : [node['@type']];
  const isProduct = typeValue.filter(Boolean).some((type) => String(type).toLowerCase() === 'product');

  if (isProduct) {
    const offerPrice = extractOfferPrice(node.offers);
    if (offerPrice) {
      return {
        price: offerPrice,
        name: typeof node.name === 'string' ? node.name : null
      };
    }
  }

  for (const value of Object.values(node)) {
    const nestedProductData = findProductDataInJsonLd(value);
    if (nestedProductData) {
      return nestedProductData;
    }
  }

  return null;
}

function extractPriceFromNextDataNode(node) {
  const candidateFields = [node.regularPrice, node.price, node.priceMin, node.priceMax];

  for (const candidate of candidateFields) {
    const price = extractNumber(String(candidate ?? ''));
    if (isNumeric(price)) {
      return price;
    }
  }

  return null;
}

function findProductDataInNextData(node) {
  if (!node) {
    return null;
  }

  if (Array.isArray(node)) {
    for (const item of node) {
      const productData = findProductDataInNextData(item);
      if (productData) {
        return productData;
      }
    }
    return null;
  }

  if (typeof node !== 'object') {
    return null;
  }

  const candidatePrice = extractPriceFromNextDataNode(node);
  const hasProductIdentity = [node.name, node.title, node.slug, node.sku, node.brand]
    .some((value) => typeof value === 'string' && value.trim() !== '');

  if (hasProductIdentity && candidatePrice) {
    return {
      price: candidatePrice,
      name: typeof node.name === 'string' && node.name.trim() !== ''
        ? node.name
        : (typeof node.title === 'string' ? node.title : null)
    };
  }

  for (const value of Object.values(node)) {
    const nestedProductData = findProductDataInNextData(value);
    if (nestedProductData) {
      return nestedProductData;
    }
  }

  return null;
}

function extractOfferPrice(offers) {
  if (!offers) {
    return null;
  }

  if (Array.isArray(offers)) {
    for (const offer of offers) {
      const price = extractOfferPrice(offer);
      if (price) {
        return price;
      }
    }
    return null;
  }

  if (typeof offers !== 'object') {
    return null;
  }

  const directPrice = extractNumber(String(offers.price || ''));
  if (isNumeric(directPrice)) {
    return directPrice;
  }

  return null;
}

function buildJsonLdPriceDiv(scriptContent, price) {
  const pricePattern = new RegExp(`(["']price["']\\s*:\\s*["']?)${escapeRegex(price)}(["']?)`, 'i');
  const match = scriptContent.match(pricePattern);

  if (!match || typeof match.index !== 'number') {
    return escapeRegex(`"price":"${price}"`).replace(escapeRegex(price), '(.*?)');
  }

  const matchedText = match[0];
  const startPos = Math.max(0, match.index - 500);
  const endPos = Math.min(scriptContent.length, match.index + matchedText.length + 500);
  const snippet = scriptContent.substring(startPos, endPos);
  const matchPlaceholder = `__PRICE_MATCH_${Date.now()}__`;
  let escapedSnippet = escapeRegex(snippet.replace(matchedText, matchPlaceholder));
  const escapedMatchedText = escapeRegex(matchedText).replace(escapeRegex(price), '(.*?)');
  escapedSnippet = escapedSnippet.replace(matchPlaceholder, escapedMatchedText);
  return escapedSnippet.trim();
}

function buildNextDataPriceDiv(scriptContent, price) {
  const pricePattern = new RegExp(`(["'](?:regularPrice|price|priceMin|priceMax)["']\\s*:\\s*["']?)${escapeRegex(price)}(["']?)`, 'i');
  const match = scriptContent.match(pricePattern);

  if (!match || typeof match.index !== 'number') {
    return escapeRegex(`"regularPrice":${price}`).replace(escapeRegex(price), '(.*?)');
  }

  const matchedText = match[0];
  const startPos = Math.max(0, match.index - 500);
  const endPos = Math.min(scriptContent.length, match.index + matchedText.length + 500);
  const snippet = scriptContent.substring(startPos, endPos);
  const matchPlaceholder = `__PRICE_MATCH_${Date.now()}__`;
  let escapedSnippet = escapeRegex(snippet.replace(matchedText, matchPlaceholder));
  const escapedMatchedText = escapeRegex(matchedText).replace(escapeRegex(price), '(.*?)');
  escapedSnippet = escapedSnippet.replace(matchPlaceholder, escapedMatchedText);
  return escapedSnippet.trim();
}

function createTrackFromMatch({ trackRequest, fullyRenderHTML, matchedPrice, priceDiv, title }) {
  return {
    orig_price: matchedPrice,
    curr_price: matchedPrice,
    requires_javascript: fullyRenderHTML,
    price_url: trackRequest.price_url,
    price_div: priceDiv,
    product_name: title,
    user_id: trackRequest.user_id,
    email: trackRequest.email,
    active: true,
    created_at: new Date(),
    last_modified_at: new Date()
  };
}


 // Finds an unknown substring in a string given a known substring to the right
 // and a known character immediately before the unknown substring.
 function findHTMLSubstringRight(html, knownRightSubstring) {
  // Step 1: Find the position of the known substring to the right
  const rightSubstringIndex = html.search(knownRightSubstring);
  if (rightSubstringIndex === -1) {
    return null;
  }

  // Step 2: Search backwards from the known substring for the `>` character
  const beforeIndex = html.lastIndexOf('>', rightSubstringIndex);
  if (beforeIndex === -1) {
    return null;
  }

  // Step 3: Extract the unknown substring
  const unknownSubstring = html.slice(beforeIndex + 1, rightSubstringIndex);
  return [null, unknownSubstring.trim()];
} 

async function setTrackAsInactive(track) {
  const previousActive = Boolean(track.active);
  const compResult = await query(
    'UPDATE track SET "active" = $1, "last_modified_at" = $2 WHERE "id" = $3',
    [false, new Date(), track.id]
  );
  if (previousActive) {
    await insertTrackHistoryEntry({
      trackId: track.id,
      priceBefore: track.curr_price,
      priceAfter: track.curr_price,
      active: false
    });
  }
  console.warn('[crawler] Track marked inactive', {
    id: track.id,
    productName: track.product_name
  });
  return sendTrackInactiveEmail(track);
}

async function setTrackAsActive(track) {
  const previousActive = Boolean(track.active);
  const compResult = await query(
    'UPDATE track SET "active" = $1, "last_modified_at" = $2 WHERE "id" = $3',
    [true, new Date(), track.id]
  );
  if (!previousActive) {
    await insertTrackHistoryEntry({
      trackId: track.id,
      priceBefore: track.curr_price,
      priceAfter: track.curr_price,
      active: true
    });
  }
}

async function findAndSavePrices(trackRequest, fullyRenderHTML, res) {
  if (!isValidMatchedPrice(trackRequest.orig_price)) {
    res.status(400).json({ error: 'Price is required and must be a valid numeric value' });
    return;
  }

  let html = '';
  if (fullyRenderHTML) {
    html = await getRenderedHTML({
      ...trackRequest,
      action: 'create-track',
      requires_javascript: true
    });
  } else {
    html = await getHTML({
      ...trackRequest,
      action: 'create-track',
      requires_javascript: false
    });
  }
    
  if (await shouldSaveHtml('create-track', false)) {
    saveHTMLFile(html, {
      action: 'create-track',
      trackId: null,
      userId: trackRequest.user_id,
      url: trackRequest.price_url
    });
  }

  const dom = new JSDOM(html);
  const document = dom.window.document;
  let title = '';

  // Get product name from title
  try {
    title = document.getElementsByTagName("title")[0].textContent || '';
  } catch (err) {
    console.warn('[crawler] No title element found in tracked page', {
      url: trackRequest.price_url
    });
  }

  let tracks = [];
  const jsonLdProduct = extractProductDataFromJsonLd(html);
  if (jsonLdProduct && isValidMatchedPrice(jsonLdProduct.price) && jsonLdProduct.price === trackRequest.orig_price) {
    console.info('[crawler] Found original price in JSON-LD product schema', {
      url: trackRequest.price_url,
      price: jsonLdProduct.price
    });
    tracks.push(createTrackFromMatch({
      trackRequest,
      fullyRenderHTML,
      matchedPrice: jsonLdProduct.price,
      priceDiv: jsonLdProduct.priceDiv,
      title: jsonLdProduct.name || title
    }));
  }

  if (tracks.length === 0) {
    const nextDataProduct = extractProductDataFromNextData(html);
    if (nextDataProduct && isValidMatchedPrice(nextDataProduct.price) && nextDataProduct.price === trackRequest.orig_price) {
      console.info('[crawler] Found original price in Next.js __NEXT_DATA__ payload', {
        url: trackRequest.price_url,
        price: nextDataProduct.price
      });
      tracks.push(createTrackFromMatch({
        trackRequest,
        fullyRenderHTML,
        matchedPrice: nextDataProduct.price,
        priceDiv: `${NEXT_DATA_PRICE_DIV_PREFIX}${nextDataProduct.priceDiv}`,
        title: nextDataProduct.name || title
      }));
    }
  }

  // Use the DOM API to extract values from elements
  const elements = Array.from(document.querySelectorAll("*")).map((x) => x.textContent);
  let htmlStringPos = 0;

  console.info('[crawler] Looking for original price on page', {
    url: trackRequest.price_url,
    price: trackRequest.orig_price,
    elementCount: elements.length,
    fullyRenderHTML
  });
  // Loop through elements to find given price
  for (let i=0;i<elements.length && tracks.length === 0;i++) {
    let htmlPrice = elements[i] || ''; 
    let htmlPriceClean = extractNumber(htmlPrice);
    
    // If element value matches price given by user it get tracked
    if (htmlPriceClean === trackRequest.orig_price) {
      
      // If price string is not found in html we try to replace spaces with HTML word breaks 
      let htmlPriceLocation = html.indexOf(htmlPrice, htmlStringPos);
      if (htmlPriceLocation === -1) {
        htmlPrice = htmlPrice.replace(/\s+/g, '&nbsp;');
        htmlPrice = htmlPrice.replace(/kr./g, '');
        htmlPriceLocation = html.indexOf(htmlPrice, htmlStringPos);
      }
      // If price string is not found in html we process next element. 
      if (htmlPriceLocation === -1) {
        console.warn('[crawler] Matching price text found but location lookup failed', {
          url: trackRequest.price_url,
          candidatePrice: htmlPrice
        });
        continue; 
      };
      
      // Get html strings around tracked price to keep track of price
      htmlStringPos = htmlPriceLocation; 
      let startPos = htmlPriceLocation - 500;
      let endPos = htmlPriceLocation + htmlPrice.length + 500;
      let priceDiv = html.substring(startPos, endPos);
      let escapedPriceDiv = escapeRegex(priceDiv); 
      let escapedHTMLPrice = escapeRegex(htmlPrice); 
      escapedPriceDiv = escapedPriceDiv.replace(escapedHTMLPrice, '(.*?)');
      //escapedPriceDiv.replace(htmlPrice, '(.*?)');
      escapedPriceDiv.trim(); // Remove trailing and leading whitespace

      tracks.push(createTrackFromMatch({
        trackRequest,
        fullyRenderHTML,
        matchedPrice: htmlPriceClean,
        priceDiv: escapedPriceDiv,
        title
      }));
      break; // For now only the first price match is tracked
    }
  }
  if (tracks.length === 0) {
    // If price was not found on plain HTML then attempt to find price on fully rendered page
    if (fullyRenderHTML) {
      let htmlFilePath = null;
      if (await shouldSaveHtml('create-track', true)) {
        htmlFilePath = saveHTMLFile(html, {
          action: 'create-track',
          trackId: null,
          userId: trackRequest.user_id,
          url: trackRequest.price_url,
          suffix: 'price-not-found'
        });
      }

      await addFailedTrackLog(trackRequest, title);
      await logCrawlerFailure(trackRequest, 'find-original-price', new Error('Price not found on page'), {
        htmlFilePath,
        fullyRenderHTML
      });
      console.warn('[crawler] Could not find price on rendered page', {
        url: trackRequest.price_url,
        price: trackRequest.orig_price
      });
      res.status(200).send('Price not found on page'); 
    } else {
      await findAndSavePrices(trackRequest, true, res);
    }
  } else {
    await addTracksToDatabase(tracks, res);
  }
}

async function addFailedTrackLog(trackRequest) {
  let domain = getDomainFromURL(trackRequest.price_url);
  try {
    // Insert data into the failed_track_logs table
    const result = await query(
      `INSERT INTO failed_track_logs (product_price, product_url, domain, created_at)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        trackRequest.orig_price, // Assuming trackRequest has these fields
        trackRequest.price_url,
        domain,
        new Date() // Setting the current timestamp
      ]
    );

    console.warn('[crawler] Failed track logged', {
      logId: result.rows[0].id,
      url: trackRequest.price_url,
      price: trackRequest.orig_price
    });
  } catch (error) {
    console.error('[crawler] Failed to insert failed-track log', {
      url: trackRequest.price_url,
      error
    });
  }
}

function getDomainFromURL(url) {
  let matches = url.match(/^https?\:\/\/([^\/?#]+)(?:[\/?#]|$)/i);
  return matches && matches[1]; // domain will be null if no match is found
}


async function addTracksToDatabase(tracks, res) {
  await ensureTrackSoftDeleteColumn();

  console.info('[crawler] Saving tracks to database', {
    trackCount: tracks.length
  });
  let trackInsertCount = 0;

  // Loop through tracks and add/update database
  for (let i = 0; i < tracks.length; i++) {
    let track = tracks[i];
    if (!isValidMatchedPrice(track.orig_price) || !isValidMatchedPrice(track.curr_price)) {
      console.warn('[crawler] Skipping invalid track price payload', {
        productName: track.product_name,
        priceUrl: track.price_url,
        origPrice: track.orig_price,
        currPrice: track.curr_price
      });
      continue;
    }

    // Product name can at most be 64 char
    track.product_name = track.product_name.substring(0, 63);
    
    // Check if track exists, if so then update existing.
    let existingTrack = await trackExists(track);
    if (existingTrack) {
      const updateResult = await query(
        'UPDATE track SET "curr_price" = $1, "last_modified_at" = $2, "price_div" = $3, "product_name" = $4, "active" = $5, "requires_javascript" = $6 WHERE "id" = $7 RETURNING *',
        [track.curr_price, new Date(), track.price_div, track.product_name, track.active, track.requires_javascript, existingTrack.id]
      );
      if (updateResult.rows[0] && updateResult.rows[0].id) {
        if (
          Number(existingTrack.curr_price) !== Number(track.curr_price) ||
          Boolean(existingTrack.active) !== Boolean(track.active)
        ) {
          await insertTrackHistoryEntry({
            trackId: existingTrack.id,
            priceBefore: existingTrack.curr_price,
            priceAfter: track.curr_price,
            active: Boolean(track.active)
          });
        }
        ++trackInsertCount;
      }
    } else {
      const insertResult = await query(
        'INSERT INTO track (orig_price, curr_price, requires_javascript, price_url, price_div, product_name, user_id, email, active, created_at, last_modified_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *',
        [ track.orig_price, track.curr_price, track.requires_javascript, track.price_url, track.price_div, track.product_name, track.user_id, track.email, track.active, track.created_at, track.last_modified_at ]
      );
      if (insertResult.rows[0].id) {
        await insertTrackHistoryEntry({
          trackId: insertResult.rows[0].id,
          priceBefore: null,
          priceAfter: track.curr_price,
          active: Boolean(track.active)
        });
        ++trackInsertCount;
      }
    }
  }
  if ( trackInsertCount === 0 ) {
    res.status(500).send('Error saving track to database');
  } else if (trackInsertCount < tracks.length) {
    res.status(206).send(trackInsertCount + ' out of ' + tracks.length + ' saved to database');
  } else {
    res.status(201).send(trackInsertCount + ' tracks saved to database');
  }
}

async function trackExists(track) {
  await ensureTrackSoftDeleteColumn();

  let existingTrackResult = await query(
    `SELECT *
     FROM track
     WHERE user_id = $1
       AND price_url = $2
       AND deleted = FALSE
     ORDER BY created_at DESC`,
    [track.user_id, track.price_url]
  );
  return existingTrackResult.rows[0];
}

async function updatePrice(newPrice, track) {
  const compResult = await query(
    'UPDATE track SET "curr_price" = $1, "last_modified_at" = $2 WHERE "id" = $3',
    [newPrice, new Date(), track.id]
  );
  await insertTrackHistoryEntry({
    trackId: track.id,
    priceBefore: track.curr_price,
    priceAfter: newPrice,
    active: Boolean(track.active)
  });
}

async function queueEmail(email) {
  const startedAt = Date.now();
  const queuedAt = email.created_at || new Date();
  email.created_at = queuedAt;
  email.delivered = false;
  email.status = 'pending';
  email.error_message = null;
  email.sent_at = null;
  email.attempt_count = 0;
  email.last_attempt_at = null;
  email.next_send_at = queuedAt;
  await insertEmail(email);
  return Date.now() - startedAt;
}

async function deliverPendingEmails(options = {}) {
  const allPendingCount = await getPendingEmailCount();
  const pendingEmails = await getPendingEmailLogs(options);
  const deferredCount = Math.max(0, allPendingCount - pendingEmails.length);

  if (pendingEmails.length === 0) {
    return {
      pendingCount: allPendingCount,
      dueCount: 0,
      deferredCount,
      sentCount: 0,
      undeliverableCount: 0,
      skippedCount: 0
    };
  }

  const sendEmailsEnabled = await getAppConfig('email.send_enabled', constants.email.sendEmail);
  if (!sendEmailsEnabled) {
    console.info('[crawler] Pending email delivery skipped because email sending is disabled', {
      pendingCount: allPendingCount,
      dueCount: pendingEmails.length
    });
    return {
      pendingCount: allPendingCount,
      dueCount: pendingEmails.length,
      deferredCount,
      sentCount: 0,
      undeliverableCount: 0,
      skippedCount: pendingEmails.length
    };
  }

  const configuredTransportMode = await getEmailTransportMode();
  let deliveryContext = null;

  try {
    deliveryContext = await createEmailTransport({ transportMode: configuredTransportMode });
  } catch (error) {
    if (error && error.code === 'EMAIL_CONFIG_MISSING') {
      console.error('[crawler] Pending email delivery skipped because configuration is incomplete', {
        pendingCount: allPendingCount,
        dueCount: pendingEmails.length,
        transportMode: configuredTransportMode,
        ...(error.details || {})
      });
      return {
        pendingCount: allPendingCount,
        dueCount: pendingEmails.length,
        deferredCount,
        sentCount: 0,
        undeliverableCount: 0,
        skippedCount: pendingEmails.length
      };
    }

    throw error;
  }

  const summary = {
    pendingCount: allPendingCount,
    dueCount: pendingEmails.length,
    deferredCount,
    sentCount: 0,
    undeliverableCount: 0,
    skippedCount: 0
  };

  for (const pendingEmail of pendingEmails) {
    const deliveryResult = await deliverPendingEmail(pendingEmail, deliveryContext);

    if (deliveryResult.status === 'sent') {
      summary.sentCount += 1;
    } else if (deliveryResult.status === 'undeliverable') {
      summary.undeliverableCount += 1;
    } else {
      summary.skippedCount += 1;
    }
  }

  console.info('[crawler] Pending email delivery finished', summary);
  return summary;
}

async function deliverPendingEmail(emailLog, deliveryContext) {
  let attemptCount = Number(emailLog.attempt_count) || 0;
  const retryDelayMs = await getEmailRetryDelayMs();

  if (attemptCount >= MAX_EMAIL_DELIVERY_ATTEMPTS) {
    await updateEmailLog(emailLog.id, {
      status: 'undeliverable',
      errorMessage: emailLog.error_message || `Failed to deliver after ${MAX_EMAIL_DELIVERY_ATTEMPTS} attempts.`,
      delivered: false,
      sentAt: null,
      attemptCount,
      lastAttemptAt: emailLog.last_attempt_at || new Date(),
      nextSendAt: null
    });
    return { status: 'undeliverable' };
  }

  while (attemptCount < MAX_EMAIL_DELIVERY_ATTEMPTS) {
    attemptCount += 1;
    const attemptedAt = new Date();

    try {
      const info = await sendQueuedEmailWithContext(emailLog, deliveryContext);

      await updateEmailLog(emailLog.id, {
        status: 'sent',
        errorMessage: null,
        delivered: true,
        sentAt: new Date(),
        attemptCount,
        lastAttemptAt: attemptedAt,
        nextSendAt: null
      });

      console.info('[crawler] Email sent', {
        emailLogId: emailLog.id,
        trackId: emailLog.track_id,
        recipient: emailLog.email,
        transportMode: deliveryContext.transportMode,
        attemptCount,
        response: info.response || info.messageId || null
      });

      return { status: 'sent' };
    } catch (error) {
      const hasAttemptsRemaining = attemptCount < MAX_EMAIL_DELIVERY_ATTEMPTS;
      const status = hasAttemptsRemaining ? 'pending' : 'undeliverable';
      const nextSendAt = hasAttemptsRemaining
        ? new Date(attemptedAt.getTime() + retryDelayMs)
        : null;

      await updateEmailLog(emailLog.id, {
        status,
        errorMessage: error.message,
        delivered: false,
        sentAt: null,
        attemptCount,
        lastAttemptAt: attemptedAt,
        nextSendAt
      });

      console.error('[crawler] Failed to deliver queued email', {
        emailLogId: emailLog.id,
        trackId: emailLog.track_id,
        recipient: emailLog.email,
        transportMode: deliveryContext.transportMode,
        attemptCount,
        status,
        error
      });

      if (!hasAttemptsRemaining) {
        return { status: 'undeliverable' };
      }
    }
  }

  return { status: 'undeliverable' };
}

async function sendQueuedEmailWithContext(emailLog, deliveryContext) {
  if (deliveryContext.transportMode === 'ses') {
    const emailBody = {};

    if (emailLog.body) {
      emailBody.Text = {
        Data: emailLog.body,
        Charset: 'UTF-8'
      };
    }

    if (emailLog.html_body) {
      emailBody.Html = {
        Data: emailLog.html_body,
        Charset: 'UTF-8'
      };
    }

    const command = new SendEmailCommand({
      FromEmailAddress: deliveryContext.senderAddress,
      Destination: {
        ToAddresses: [emailLog.email]
      },
      Content: {
        Simple: {
          Subject: {
            Data: emailLog.subject || '',
            Charset: 'UTF-8'
          },
          Body: emailBody
        }
      }
    });

    const response = await deliveryContext.sesClient.send(command);
    return {
      messageId: response.MessageId || null,
      response: response.MessageId || null
    };
  }

  return deliveryContext.transporter.sendMail({
    from: deliveryContext.senderAddress,
    to: emailLog.email,
    subject: emailLog.subject,
    text: emailLog.body,
    html: emailLog.html_body || undefined
  });
}

async function createEmailTransport({ emailAddress, transportMode = null }) {
  const resolvedTransportMode = transportMode || await getEmailTransportMode();
  const resolvedEmailAddress = resolvedTransportMode === 'ses'
    ? await getAppConfig('email.ses_address', constants.email.sesAddress)
    : (emailAddress || await getAppConfig('email.address', keys.email && keys.email.address));

  if (!resolvedEmailAddress) {
    throw createMissingEmailConfigError(
      resolvedTransportMode === 'ses'
        ? 'Email configuration is incomplete. Expected email.ses_address for outgoing SES mail.'
        : 'Email configuration is incomplete. Expected email.address for outgoing mail.',
      {
        transportMode: resolvedTransportMode,
        hasAddress: Boolean(resolvedEmailAddress)
      }
    );
  }

  if (resolvedTransportMode === 'ses') {
    const awsConfig = getAwsMailConfig();

    if (!awsConfig.accessKeyId || !awsConfig.secretAccessKey || !awsConfig.region) {
      throw createMissingEmailConfigError(
        'Email configuration is incomplete for SES. Expected aws access key, secret access key and region.',
        {
          transportMode: resolvedTransportMode,
          hasAccessKeyId: Boolean(awsConfig.accessKeyId),
          hasSecretAccessKey: Boolean(awsConfig.secretAccessKey),
          hasRegion: Boolean(awsConfig.region)
        }
      );
    }

    const sesClient = new SESv2Client({
      region: awsConfig.region,
      credentials: {
        accessKeyId: awsConfig.accessKeyId,
        secretAccessKey: awsConfig.secretAccessKey
      }
    });

    return {
      senderAddress: resolvedEmailAddress,
      transportMode: resolvedTransportMode,
      sesClient
    };
  }

  const emailService = await getAppConfig('email.service', keys.email && keys.email.service);
  const emailPassword = await getAppConfig('email.password', keys.email && keys.email.password);

  if (!emailService || !emailPassword) {
    throw createMissingEmailConfigError(
      'Email configuration is incomplete for SMTP. Expected email.service, email.address and email.password.',
      {
        transportMode: resolvedTransportMode,
        hasService: Boolean(emailService),
        hasAddress: Boolean(resolvedEmailAddress),
        hasPassword: Boolean(emailPassword)
      }
    );
  }

  return {
    senderAddress: resolvedEmailAddress,
    transportMode: resolvedTransportMode,
    transporter: nodemailer.createTransport({
      service: emailService,
      connectionTimeout: 15000,
      greetingTimeout: 15000,
      socketTimeout: 20000,
      auth: {
        user: resolvedEmailAddress,
        pass: emailPassword
      }
    })
  };
}

async function getEmailTransportMode() {
  const configuredTransportMode = await getAppConfig(
    'email.transport_mode',
    constants.email.transportMode
  );
  return normalizeEmailTransportMode(configuredTransportMode);
}

function normalizeEmailTransportMode(value) {
  const normalizedValue = String(value || '').trim().toLowerCase();
  if (normalizedValue === 'ses') {
    return 'ses';
  }

  return 'smtp';
}

function createMissingEmailConfigError(message, details) {
  const error = new Error(message);
  error.code = 'EMAIL_CONFIG_MISSING';
  error.details = details;
  return error;
}

function getAwsMailConfig() {
  const awsConfig = keys.aws || {};
  return {
    accessKeyId: awsConfig.AWS_ACCESS_KEY_ID || awsConfig.accessKeyId || process.env.AWS_ACCESS_KEY_ID || '',
    secretAccessKey: awsConfig.AWS_SECRET_ACCESS_KEY || awsConfig.secretAccessKey || process.env.AWS_SECRET_ACCESS_KEY || '',
    region: awsConfig.AWS_REGION || awsConfig.region || process.env.AWS_REGION || ''
  };
}

async function sendPriceUpdateEmail(track, options = {}) {
  const renderedEmail = await renderEmailTemplate('price_change', {
    productName: track.product_name,
    productUrl: track.price_url,
    originalPrice: track.orig_price,
    previousPrice: options.previousPrice,
    currentPrice: track.curr_price
  });

  const email = {
    track_id: track.id,
    product_name: track.product_name,
    orig_price: track.orig_price,
    curr_price: track.curr_price,
    email: track.email,
    email_type: 'price_change',
    template_key: renderedEmail.templateKey,
    delivered: false,
    created_at: new Date(),
    subject: renderedEmail.subject,
    body: renderedEmail.text,
    html_body: renderedEmail.html
  };
  return queueEmail(email);
}

async function sendTrackInactiveEmail(track) {
  const renderedEmail = await renderEmailTemplate('track_inactive', {
    productName: track.product_name,
    productUrl: track.price_url,
    originalPrice: track.orig_price
  });

  const email = {
    track_id: track.id,
    product_name: track.product_name,
    orig_price: track.orig_price,
    curr_price: null,
    email: track.email,
    email_type: 'track_inactive',
    template_key: renderedEmail.templateKey,
    delivered: false,
    created_at: new Date(),
    subject: renderedEmail.subject,
    body: renderedEmail.text,
    html_body: renderedEmail.html
  };
  return queueEmail(email);
}

async function sendTemplateTestEmail({
  templateKey,
  recipientEmail,
  productName,
  productUrl,
  originalPrice = null,
  previousPrice = null,
  currentPrice = null
}) {
  const renderedEmail = await renderEmailTemplate(templateKey, {
    productName,
    productUrl,
    originalPrice,
    previousPrice,
    currentPrice
  });

  const email = {
    track_id: null,
    product_name: productName,
    orig_price: originalPrice,
    curr_price: currentPrice,
    email: recipientEmail,
    email_type: templateKey,
    template_key: renderedEmail.templateKey,
    delivered: false,
    created_at: new Date(),
    status: 'pending',
    subject: renderedEmail.subject,
    body: renderedEmail.text,
    html_body: renderedEmail.html
  };

  const emailLog = await insertEmail(email);
  if (!emailLog) {
    throw new Error('Failed to create email log');
  }

  const deliveryContext = await createEmailTransport({});
  const deliveryResult = await deliverPendingEmail(emailLog, deliveryContext);

  if (deliveryResult.status !== 'sent') {
    throw new Error('Failed to send test email');
  }

  return {
    emailLogId: emailLog.id,
    recipient: recipientEmail,
    subject: renderedEmail.subject,
    status: deliveryResult.status
  };
}

let emailLogTableReadyPromise = null;

async function ensureEmailLogTable() {
  if (!emailLogTableReadyPromise) {
    emailLogTableReadyPromise = ensureEmailLogTableColumns().catch((error) => {
      emailLogTableReadyPromise = null;
      throw error;
    });
  }

  await emailLogTableReadyPromise;
}

async function ensureEmailLogTableColumns() {
  await query(`
    CREATE TABLE IF NOT EXISTS email_logs (
      "id" serial PRIMARY KEY,
      "track_id" integer,
      "product_name" varchar(64),
      "orig_price" numeric,
      "curr_price" numeric,
      "email" varchar(256),
      "email_type" varchar(64),
      "template_key" varchar(64),
      "status" varchar(32),
      "subject" text,
      "body" text,
      "html_body" text,
      "error_message" text,
      "delivered" boolean,
      "sent_at" timestamp,
      "attempt_count" integer NOT NULL DEFAULT 0,
      "last_attempt_at" timestamp,
      "next_send_at" timestamp,
      "created_at" timestamp
    )
  `);

  await query(`
    ALTER TABLE email_logs
      ADD COLUMN IF NOT EXISTS track_id integer,
      ADD COLUMN IF NOT EXISTS product_name varchar(64),
      ADD COLUMN IF NOT EXISTS orig_price numeric,
      ADD COLUMN IF NOT EXISTS curr_price numeric,
      ADD COLUMN IF NOT EXISTS email varchar(256),
      ADD COLUMN IF NOT EXISTS email_type varchar(64),
      ADD COLUMN IF NOT EXISTS template_key varchar(64),
      ADD COLUMN IF NOT EXISTS status varchar(32),
      ADD COLUMN IF NOT EXISTS subject text,
      ADD COLUMN IF NOT EXISTS body text,
      ADD COLUMN IF NOT EXISTS html_body text,
      ADD COLUMN IF NOT EXISTS error_message text,
      ADD COLUMN IF NOT EXISTS delivered boolean,
      ADD COLUMN IF NOT EXISTS sent_at timestamp,
      ADD COLUMN IF NOT EXISTS attempt_count integer NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS last_attempt_at timestamp,
      ADD COLUMN IF NOT EXISTS next_send_at timestamp,
      ADD COLUMN IF NOT EXISTS created_at timestamp
  `);
}

async function insertEmail(email) {
  try {
    await ensureEmailLogTable();
    // Insert email data into the database
    const result = await query(
      `INSERT INTO email_logs (
        track_id,
        product_name,
        orig_price,
        curr_price,
        email,
        email_type,
        template_key,
        status,
        subject,
        body,
        html_body,
        error_message,
        delivered,
        sent_at,
        attempt_count,
        last_attempt_at,
        next_send_at,
        created_at
      )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)
       RETURNING *`,
      [
        email.track_id,
        email.product_name,
        email.orig_price,
        email.curr_price,
        email.email,
        email.email_type || 'generic',
        email.template_key || null,
        email.status || (email.delivered ? 'sent' : 'pending'),
        email.subject || null,
        email.body || null,
        email.html_body || null,
        email.error_message || null,
        email.delivered,
        email.sent_at || null,
        Number.isFinite(email.attempt_count) ? email.attempt_count : 0,
        email.last_attempt_at || null,
        email.next_send_at || email.created_at || new Date(),
        email.created_at
      ]
    );

    console.info('[crawler] Email log inserted', {
      emailLogId: result.rows[0].id,
      trackId: email.track_id,
      status: result.rows[0].status
    });
    return result.rows[0];
  } catch (error) {
    console.error('[crawler] Failed to insert email log', {
      trackId: email.track_id,
      recipient: email.email,
      error
    });
    return null;
  }
}

async function getPendingEmailLogs(options = {}) {
  await ensureEmailLogTable();
  const whereClause = options.ignoreSchedule
    ? `status IN ('pending', 'skipped_disabled', 'skipped_missing_config')`
    : `status IN ('pending', 'skipped_disabled', 'skipped_missing_config')
       AND (next_send_at IS NULL OR next_send_at <= NOW())`;
  const result = await query(
    `SELECT *
     FROM email_logs
     WHERE ${whereClause}
     ORDER BY created_at ASC NULLS LAST, id ASC`
  );

  return result.rows;
}

async function getPendingEmailCount() {
  await ensureEmailLogTable();
  const result = await query(
    `SELECT COUNT(*)::int AS total
     FROM email_logs
     WHERE status IN ('pending', 'skipped_disabled', 'skipped_missing_config')`
  );

  return result.rows[0] ? result.rows[0].total : 0;
}

async function updateEmailLog(emailLogId, {
  status,
  errorMessage = null,
  delivered = false,
  sentAt = null,
  attemptCount = 0,
  lastAttemptAt = null,
  nextSendAt = null
}) {
  await ensureEmailLogTable();
  await query(
    `UPDATE email_logs
     SET status = $2,
         error_message = $3,
         delivered = $4,
         sent_at = $5,
         attempt_count = $6,
         last_attempt_at = $7,
         next_send_at = $8
     WHERE id = $1`,
    [
      emailLogId,
      status,
      errorMessage,
      delivered,
      sentAt,
      attemptCount,
      lastAttemptAt,
      nextSendAt
    ]
  );
}

async function batchUpdateEmailLogs(emailLogIds, {
  status,
  errorMessage = null,
  delivered = false,
  sentAt = null,
  lastAttemptAt = null,
  nextSendAt = null
}) {
  if (!emailLogIds || emailLogIds.length === 0) {
    return;
  }

  await ensureEmailLogTable();
  await query(
    `UPDATE email_logs
     SET status = $2,
         error_message = $3,
         delivered = $4,
         sent_at = $5,
         last_attempt_at = $6,
         next_send_at = $7
     WHERE id = ANY($1::int[])`,
    [
      emailLogIds,
      status,
      errorMessage,
      delivered,
      sentAt,
      lastAttemptAt,
      nextSendAt
    ]
  );
}

async function getEmailRetryDelayMs() {
  const retryDelayMs = await getAppConfig('email.retry_delay_ms', constants.email.retryDelayMs);
  return Number.isFinite(retryDelayMs) && retryDelayMs >= 0
    ? retryDelayMs
    : constants.email.retryDelayMs;
}

function extractNumber(price) {
  return price.replace(/\D/g,'');
}

function escapeRegex(string) {
  return string.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

function isNumeric(value) {
  return /^\d+$/.test(value);
}

function isValidMatchedPrice(value) {
  return isNumeric(value) && value.length <= 20 && Number(value) <= MAX_MATCH_PRICE;
}

async function shouldSaveHtml(action, failedOnly) {
  const isUpdateAction = action === 'update';
  const enabled = await getAppConfig(
    isUpdateAction ? 'html.save_update_track_html' : 'html.save_new_track_html',
    isUpdateAction ? constants.html.saveUpdateTrackHTML : constants.html.saveNewTrackHTML
  );

  if (!enabled) {
    return false;
  }

  const onlyFailed = await getAppConfig('html.only_failed', constants.html.onlyFailed);
  if (!onlyFailed) {
    return true;
  }

  return Boolean(failedOnly);
}

function getActionName(target) {
  return target.action || 'update';
}

function buildHtmlFilePath(metadata) {
  const safeUrl = (metadata.url || 'unknown')
    .slice(0, 40)
    .replace(/[^A-Za-z0-9]/g, '');
  const parts = [
    metadata.action || 'html',
    metadata.trackId || 'no-track',
    metadata.userId || 'no-user',
    metadata.suffix || 'snapshot',
    Date.now(),
    safeUrl
  ];
  return `./HTMLs/${parts.join('_')}.html`;
}

async function logCrawlerFailure(target, stage, error, extraDetails = {}) {
  try {
    const failure = await insertCrawlerFailureLog({
      run_id: target.run_id || null,
      run_item_id: target.run_item_id || null,
      track_id: target.id || null,
      user_id: target.user_id || null,
      user_email: target.email || null,
      action: getActionName(target),
      stage,
      product_name: target.product_name || null,
      product_url: target.price_url || null,
      requires_javascript: target.requires_javascript,
      html_file_path: extraDetails.htmlFilePath || null,
      error_message: error && error.message ? error.message : 'Unknown crawler error',
      error_stack: error && error.stack ? error.stack : null,
      details: {
        ...extraDetails,
        errorDetails: error && error.details ? error.details : null
      }
    });

    console.error('[crawler] Failure logged', {
      failureLogId: failure.id,
      trackId: target.id || null,
      stage,
      url: target.price_url || null
    });
    return failure.id;
  } catch (logError) {
    console.error('[crawler] Failed to persist crawler failure log', {
      stage,
      url: target.price_url || null,
      error: logError
    });
    return null;
  }
}

async function processTrackUpdate(track, runId) {
  const startedAt = Date.now();
  let itemResult = createRunItemResult(track);

  try {
    const trackContext = {
      ...track,
      action: 'update',
      run_id: runId
    };

    let html = '';
    if (track.requires_javascript) {
      html = await getRenderedHTML(trackContext);
    } else {
      html = await getHTML(trackContext);
    }

    itemResult.htmlLookupSuccess = true;
    itemResult.stage = track.requires_javascript ? 'render-html' : 'fetch-html';

    if (await shouldSaveHtml('update', false)) {
      saveHTMLFile(html, {
        action: 'update',
        trackId: track.id,
        userId: track.user_id,
        url: track.price_url
      });
    }

    itemResult = {
      ...itemResult,
      ...(await findPriceFromDiv(html, trackContext))
    };
  } catch (error) {
    itemResult = await handleUnexpectedTrackError(track, runId, error, itemResult);

    console.error('[crawler] Track update failed', {
      runId,
      id: track.id,
      productName: track.product_name,
      url: track.price_url,
      durationMs: Date.now() - startedAt,
      error
    });
  }

  itemResult.durationMs = Math.max(0, Date.now() - startedAt - (itemResult.emailDurationMs || 0));
  return itemResult;
}

async function handleUnexpectedTrackError(track, runId, error, existingResult = null) {
  const stage = error && error.details && error.details.stage
    ? error.details.stage
    : (track.requires_javascript ? 'render-html' : 'fetch-html');

  let failureLogId = error && error.details ? error.details.failureLogId || null : null;
  if (!failureLogId) {
    failureLogId = await logCrawlerFailure(
      {
        ...track,
        action: 'update',
        run_id: runId
      },
      stage,
      error,
      {}
    );
  }

  let markedInactive = false;
  try {
    const inactiveEmailDurationMs = await setTrackAsInactive(track);
    track.active = false;
    markedInactive = true;
    if (existingResult) {
      existingResult.emailDurationMs = inactiveEmailDurationMs;
    }
  } catch (inactiveError) {
    console.error('[crawler] Failed to mark track inactive after unexpected error', {
      runId,
      trackId: track.id,
      error: inactiveError
    });
  }

  return {
    ...(existingResult || createRunItemResult(track)),
    status: 'fetch_failed',
    stage,
    previousPrice: existingResult && existingResult.previousPrice != null ? existingResult.previousPrice : track.curr_price,
    currentPrice: existingResult && existingResult.currentPrice != null ? existingResult.currentPrice : null,
    priceDirection: existingResult ? existingResult.priceDirection : null,
    markedInactive,
    reactivated: false,
    failureLogId,
    errorMessage: error && error.message ? error.message : 'Unexpected crawler error',
    emailDurationMs: existingResult && existingResult.emailDurationMs ? existingResult.emailDurationMs : 0
  };
}

function createRunSummary(startedAt) {
  return {
    status: 'running',
    started_at: startedAt,
    finished_at: null,
    duration_ms: 0,
    track_count: 0,
    html_success_count: 0,
    html_failure_count: 0,
    unchanged_count: 0,
    updated_count: 0,
    lowered_count: 0,
    increased_count: 0,
    inactive_count: 0,
    reactivated_count: 0,
    error_count: 0,
    biggest_drop_amount: null,
    biggest_increase_amount: null
  };
}

function createRunItemResult(track) {
  return {
    status: 'pending',
    stage: 'start',
    htmlLookupSuccess: false,
    previousPrice: track.curr_price,
    currentPrice: track.curr_price,
    priceDirection: null,
    markedInactive: false,
    reactivated: false,
    failureLogId: null,
    errorMessage: null,
    durationMs: 0,
    emailDurationMs: 0
  };
}

function applyRunItemToSummary(summary, item) {
  summary.track_count += 1;

  if (item.htmlLookupSuccess) {
    summary.html_success_count += 1;
  } else {
    summary.html_failure_count += 1;
  }

  if (item.status === 'unchanged') {
    summary.unchanged_count += 1;
  }

  if (item.status === 'updated_lower' || item.status === 'updated_higher' || item.status === 'updated_other') {
    summary.updated_count += 1;
  }

  if (item.status === 'updated_lower') {
    summary.lowered_count += 1;
    const dropAmount = Number(item.previousPrice) - Number(item.currentPrice);
    if (Number.isFinite(dropAmount)) {
      summary.biggest_drop_amount = summary.biggest_drop_amount == null
        ? dropAmount
        : Math.max(summary.biggest_drop_amount, dropAmount);
    }
  }

  if (item.status === 'updated_higher') {
    summary.increased_count += 1;
    const increaseAmount = Number(item.currentPrice) - Number(item.previousPrice);
    if (Number.isFinite(increaseAmount)) {
      summary.biggest_increase_amount = summary.biggest_increase_amount == null
        ? increaseAmount
        : Math.max(summary.biggest_increase_amount, increaseAmount);
    }
  }

  if (item.markedInactive) {
    summary.inactive_count += 1;
  }

  if (item.reactivated) {
    summary.reactivated_count += 1;
  }

  if (item.failureLogId || item.errorMessage) {
    summary.error_count += 1;
  }
}

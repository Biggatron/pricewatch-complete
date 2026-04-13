const fs = require('fs');
const path = require('path');
const query = require('../db/db');
const constants = require('../config/const');
const { getAppConfig } = require('./app-config');
const {
  extractDomainFromUrl,
  getFreshDomainAccessProfileByUrl,
  DOMAIN_PROFILE_PREVIEW_MODES,
  upsertDomainAccessProfile
} = require('./domain-access-profile');
const {
  delay,
  getPuppeteerPageDiagnostics,
  getRandomUserAgent,
  getSharedBrowser
} = require('./crawler-http');
const fetch = (...args) => import('node-fetch').then(({ default: fetchModule }) => fetchModule(...args));

const PREVIEW_OUTPUT_DIR = path.join(__dirname, '..', 'public', 'generated-previews');
const PREVIEW_IMAGE_EXTENSION = '.png';
const PREVIEW_TIMEOUT_MS = 6000;
const PREVIEW_IFRAME_RUNTIME_SETTLE_MS = 4000;
const PREVIEW_IFRAME_ERROR_TEXT_PATTERN = /application error:\s*a client-side exception has occurred while loading/i;
const PREVIEW_IFRAME_RUNTIME_ERROR_PATTERN = /current origin is not supported|targetorigin|client-side exception/i;
const PREVIEW_CLEANUP_INTERVAL_MS = 1000 * 60 * 10;
const PREVIEW_ORPHAN_GRACE_MS = 1000 * 60 * 5;
const PREVIEW_CACHE_CONFIG_KEY = 'preview.screenshot_cache_duration_ms';
const PREVIEW_POST_NAVIGATION_DELAY_CONFIG_KEY = 'preview.post_navigation_delay_ms';
const PREVIEW_POST_BANNER_DELAY_CONFIG_KEY = 'preview.post_banner_delay_ms';
const PREVIEW_VIEWPORT = {
  width: 1280,
  height: 1600
};
const PREVIEW_FORCE_SCREENSHOT_DOMAINS = new Set([
  'bauhaus.is'
]);

const previewScreenshotInflight = new Map();

let lastPreviewCleanupAt = 0;
let previewCacheTableReadyPromise = null;
let previewLegacyMigrationPromise = null;

async function ensurePreviewCacheTable() {
  if (!previewCacheTableReadyPromise) {
    previewCacheTableReadyPromise = ensurePreviewCacheTableInternal().catch((error) => {
      previewCacheTableReadyPromise = null;
      throw error;
    });
  }

  await previewCacheTableReadyPromise;
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

async function migrateLegacyPreviewMetadataFiles() {
  if (!previewLegacyMigrationPromise) {
    previewLegacyMigrationPromise = migrateLegacyPreviewMetadataFilesInternal().catch((error) => {
      previewLegacyMigrationPromise = null;
      throw error;
    });
  }

  await previewLegacyMigrationPromise;
}

async function migrateLegacyPreviewMetadataFilesInternal() {
  await ensurePreviewCacheTable();

  if (!fs.existsSync(PREVIEW_OUTPUT_DIR)) {
    return { migratedCount: 0, removedCount: 0 };
  }

  let migratedCount = 0;
  let removedCount = 0;
  const fileNames = fs.readdirSync(PREVIEW_OUTPUT_DIR)
    .filter((fileName) => fileName.endsWith(`${PREVIEW_IMAGE_EXTENSION}.json`));

  for (const fileName of fileNames) {
    const metadataPath = path.join(PREVIEW_OUTPUT_DIR, fileName);
    const filePath = metadataPath.slice(0, -'.json'.length);
    const fileExists = fs.existsSync(filePath);
    const metadata = readLegacyPreviewMetadata(metadataPath);

    if (!fileExists || !metadata || !metadata.url) {
      removeLegacyPreviewMetadataFile(metadataPath);
      removedCount += 1;
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
    migratedCount += 1;
  }

  return { migratedCount, removedCount };
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

async function getUrlPreview(inputUrl) {
  const normalizedUrl = normalizePreviewUrl(inputUrl);
  const normalizedDomain = extractDomainFromUrl(normalizedUrl);
  const domainAccessProfile = await getFreshDomainAccessProfileByUrl(normalizedUrl);

  if (normalizedDomain && PREVIEW_FORCE_SCREENSHOT_DOMAINS.has(normalizedDomain)) {
    await upsertDomainAccessProfile({
      url: normalizedUrl,
      previewMode: DOMAIN_PROFILE_PREVIEW_MODES.SCREENSHOT
    });

    const imageUrl = await capturePreviewScreenshot(normalizedUrl);
    return {
      mode: 'screenshot',
      url: normalizedUrl,
      imageUrl,
      reason: 'forced_domain_fallback'
    };
  }

  if (domainAccessProfile && domainAccessProfile.preview_mode === DOMAIN_PROFILE_PREVIEW_MODES.IFRAME) {
    return {
      mode: 'iframe',
      url: normalizedUrl
    };
  }

  if (domainAccessProfile && domainAccessProfile.preview_mode === DOMAIN_PROFILE_PREVIEW_MODES.SCREENSHOT) {
    const imageUrl = await capturePreviewScreenshot(normalizedUrl);
    return {
      mode: 'screenshot',
      url: normalizedUrl,
      imageUrl,
      reason: 'domain_profile'
    };
  }

  const iframeDecision = await inspectIframeSupport(normalizedUrl);
  await upsertDomainAccessProfile({
    url: normalizedUrl,
    previewMode: iframeDecision.mode === 'screenshot'
      ? DOMAIN_PROFILE_PREVIEW_MODES.SCREENSHOT
      : DOMAIN_PROFILE_PREVIEW_MODES.IFRAME
  });

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

    const runtimeDecision = await inspectIframeRuntimeSupport(finalUrl);
    if (runtimeDecision.mode === 'screenshot') {
      return runtimeDecision;
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

async function inspectIframeRuntimeSupport(url) {
  const browser = await getSharedBrowser();
  const page = await browser.newPage();
  const runtimeErrors = [];

  page.on('pageerror', (error) => {
    const message = error && error.message ? error.message : String(error || '');
    if (message) {
      runtimeErrors.push(message);
    }
  });

  try {
    await page.setViewport(PREVIEW_VIEWPORT);
    await page.setUserAgent(getRandomUserAgent());
    await page.setContent(`
      <!doctype html>
      <html>
        <body style="margin:0;padding:0;background:#fff;">
          <div id="preview-frame-root"></div>
          <script>
            window.__previewFrameLoaded = false;
            const iframe = document.createElement('iframe');
            iframe.src = ${JSON.stringify(url)};
            iframe.width = '1280';
            iframe.height = '1600';
            iframe.style.border = '0';
            iframe.style.width = '1280px';
            iframe.style.height = '1600px';
            iframe.addEventListener('load', function () {
              window.__previewFrameLoaded = true;
            }, { once: true });
            document.getElementById('preview-frame-root').appendChild(iframe);
          </script>
        </body>
      </html>
    `, {
      waitUntil: 'domcontentloaded'
    });

    await page.waitForFunction(() => window.__previewFrameLoaded === true, {
      timeout: PREVIEW_TIMEOUT_MS
    }).catch(() => null);
    await delay(PREVIEW_IFRAME_RUNTIME_SETTLE_MS);

    const frameTexts = [];
    for (const frame of page.frames()) {
      const frameUrl = typeof frame.url === 'function' ? frame.url() : '';
      if (!frameUrl || frameUrl === 'about:blank') {
        continue;
      }

      try {
        const text = await frame.evaluate(() => (
          document && document.body && typeof document.body.innerText === 'string'
            ? document.body.innerText.slice(0, 600)
            : ''
        ));
        frameTexts.push(text);
      } catch (error) {
        continue;
      }
    }

    const matchedRuntimeError = runtimeErrors.find((message) => PREVIEW_IFRAME_RUNTIME_ERROR_PATTERN.test(message));
    const matchedFrameErrorText = frameTexts.find((text) => PREVIEW_IFRAME_ERROR_TEXT_PATTERN.test(text));

    if (matchedRuntimeError || matchedFrameErrorText) {
      console.info('[preview] Falling back to screenshot after iframe runtime failure', {
        url,
        runtimeError: matchedRuntimeError || null,
        frameErrorText: matchedFrameErrorText || null
      });
      return {
        mode: 'screenshot',
        url,
        reason: 'iframe_runtime_error'
      };
    }

    return {
      mode: 'iframe',
      url,
      reason: null
    };
  } catch (error) {
    console.warn('[preview] Failed to inspect iframe runtime support, keeping iframe preview', {
      url,
      error
    });
    return {
      mode: 'iframe',
      url,
      reason: 'runtime_inspection_failed'
    };
  } finally {
    await page.close().catch(() => null);
  }
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
    const browser = await getSharedBrowser();
    const page = await browser.newPage();
    const userAgent = getRandomUserAgent();

    try {
      await page.setViewport(PREVIEW_VIEWPORT);
      await page.setUserAgent(userAgent);
      const response = await page.goto(url, {
        waitUntil: 'domcontentloaded',
        timeout: PREVIEW_TIMEOUT_MS
      });
      const navigationDetails = await getPuppeteerPageDiagnostics(page, response);

      if (navigationDetails.status && navigationDetails.status >= 400) {
        console.error('[preview] Non-OK screenshot response', {
          url,
          status: navigationDetails.status,
          statusText: navigationDetails.statusText,
          responseUrl: navigationDetails.responseUrl,
          pageUrl: navigationDetails.pageUrl,
          title: navigationDetails.title,
          userAgent,
          headers: navigationDetails.responseHeaders,
          html: navigationDetails.responseHtml
        });

        const error = new Error(`Preview HTTP error! Status: ${navigationDetails.status}`);
        error.details = {
          url,
          status: navigationDetails.status,
          statusText: navigationDetails.statusText,
          responseUrl: navigationDetails.responseUrl,
          pageUrl: navigationDetails.pageUrl,
          title: navigationDetails.title,
          userAgent,
          responseHeaders: navigationDetails.responseHeaders,
          responseHtml: navigationDetails.responseHtml
        };
        throw error;
      }

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
    } catch (error) {
      const failureDetails = await getPuppeteerPageDiagnostics(page).catch(() => ({}));
      console.error('[preview] Screenshot capture failed', {
        url,
        userAgent,
        pageUrl: failureDetails.pageUrl || null,
        title: failureDetails.title || null,
        html: failureDetails.responseHtml || null,
        error
      });
      throw error;
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
      '[aria-label*="close"]',
      '[class*="close"]'
    ],
    [
      'button',
      '[role="button"]'
    ]
  ];

  const buttonPatterns = [
    /reject/i,
    /hafna/i,
    /only necessary/i,
    /necessary only/i,
    /essential only/i,
    /allow selection/i,
    /close/i,
    /loka/i
  ];

  for (const selectors of selectorGroups) {
    const clicked = await frame.evaluate(({ selectors, buttonPatterns: serializedPatterns }) => {
      const patterns = serializedPatterns.map((pattern) => new RegExp(pattern, 'i'));

      for (const selector of selectors) {
        const elements = Array.from(document.querySelectorAll(selector));
        for (const element of elements) {
          if (!element || typeof element.click !== 'function') {
            continue;
          }

          const text = `${element.textContent || ''} ${element.getAttribute('aria-label') || ''}`.trim();
          if (selector === 'button' || selector === '[role="button"]') {
            if (!patterns.some((pattern) => pattern.test(text))) {
              continue;
            }
          }

          element.click();
          return true;
        }
      }

      return false;
    }, {
      selectors,
      buttonPatterns: buttonPatterns.map((pattern) => pattern.source)
    }).catch(() => false);

    if (clicked) {
      return true;
    }
  }

  return false;
}

async function hideCookieOverlayInFrame(frame) {
  await frame.evaluate(() => {
    const overlaySelectors = [
      '#onetrust-consent-sdk',
      '.onetrust-pc-dark-filter',
      '.cmplz-cookiebanner',
      '[class*="cookie"][class*="overlay"]',
      '[id*="cookie"][id*="overlay"]'
    ];

    overlaySelectors.forEach((selector) => {
      document.querySelectorAll(selector).forEach((element) => {
        element.style.display = 'none';
        element.style.visibility = 'hidden';
        element.style.opacity = '0';
        element.style.pointerEvents = 'none';
      });
    });

    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }).catch(() => null);
}

async function getCachedPreviewScreenshot(url) {
  const cachedEntry = await getPreviewCacheEntryByUrl(url);
  if (!cachedEntry) {
    return null;
  }

  const expiresAt = cachedEntry.expires_at ? cachedEntry.expires_at.getTime() : 0;
  const isExpired = !expiresAt || expiresAt <= Date.now();
  const fileExists = cachedEntry.file_path && fs.existsSync(cachedEntry.file_path);

  if (isExpired || !fileExists) {
    await deletePreviewCacheEntry(cachedEntry, {
      deleteFile: false
    });
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
  await cleanupOldPreviewFiles({
    processLegacyMetadataFiles: false
  });
}

async function cleanupOldPreviewFiles(options = {}) {
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
      if (options.processLegacyMetadataFiles) {
        removeLegacyPreviewMetadataFile(absolutePath);
        summary.legacyMetadataFilesRemoved += 1;
      }
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

async function cleanupStoredPreviewFiles() {
  lastPreviewCleanupAt = Date.now();
  await migrateLegacyPreviewMetadataFiles();
  const summary = await cleanupOldPreviewFiles({
    processLegacyMetadataFiles: true
  });
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
  await migrateLegacyPreviewMetadataFiles();
  lastPreviewCleanupAt = Date.now();
  await cleanupOldPreviewFiles({
    processLegacyMetadataFiles: true
  });
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
        fileName: entry.file_name,
        publicPath: entry.public_path,
        filePath: entry.file_path,
        exists: fileExists,
        sizeBytes,
        createdAt: entry.created_at,
        lastAccessedAt: entry.last_accessed_at,
        expiresAt: entry.expires_at,
        url: entry.url
      };
    });

  return {
    screenshotDirectory: PREVIEW_OUTPUT_DIR,
    screenshotFiles
  };
}

module.exports = {
  cleanupStoredPreviewFiles,
  ensurePreviewCacheTable,
  getPreviewCacheSummary,
  getUrlPreview,
  migrateLegacyPreviewMetadataFiles
};

const puppeteer = require('puppeteer');
const fetch = (...args) => import('node-fetch').then(({ default: fetchModule }) => fetchModule(...args));

const DEFAULT_MAX_ATTEMPTS = 3;

let sharedBrowserPromise = null;

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

function delay(durationMs) {
  return new Promise((resolve) => {
    setTimeout(resolve, durationMs);
  });
}

function getResponseHeadersObject(response) {
  const headers = {};

  if (!response || !response.headers || typeof response.headers.forEach !== 'function') {
    return headers;
  }

  response.headers.forEach((value, key) => {
    headers[key] = value;
  });

  return headers;
}

function getPuppeteerResponseDetails(response) {
  if (!response) {
    return {
      status: null,
      statusText: null,
      responseUrl: null,
      responseHeaders: null
    };
  }

  return {
    status: typeof response.status === 'function' ? response.status() : null,
    statusText: typeof response.statusText === 'function' ? response.statusText() : null,
    responseUrl: typeof response.url === 'function' ? response.url() : null,
    responseHeaders: typeof response.headers === 'function' ? response.headers() : null
  };
}

async function getPuppeteerPageDiagnostics(page, response = null) {
  const responseDetails = getPuppeteerResponseDetails(response);
  let pageUrl = null;
  let title = null;
  let responseHtml = null;

  try {
    pageUrl = page.url();
  } catch (error) {
    pageUrl = null;
  }

  try {
    title = await page.title();
  } catch (error) {
    title = null;
  }

  try {
    responseHtml = await page.content();
  } catch (error) {
    responseHtml = null;
  }

  return {
    ...responseDetails,
    pageUrl,
    title,
    responseHtml
  };
}

async function getSharedBrowser() {
  if (!sharedBrowserPromise) {
    sharedBrowserPromise = puppeteer.launch().then((browser) => {
      browser.on('disconnected', () => {
        sharedBrowserPromise = null;
      });
      return browser;
    }).catch((error) => {
      sharedBrowserPromise = null;
      throw error;
    });
  }

  return sharedBrowserPromise;
}

async function fetchHtmlDirect(target, options = {}) {
  const normalizedTarget = typeof target === 'string' ? { price_url: target } : target;
  let attempts = 0;
  let lastError = null;
  let finalFailureDetails = null;

  while (attempts < (options.maxAttempts || DEFAULT_MAX_ATTEMPTS)) {
    try {
      const randomUserAgent = getRandomUserAgent();
      const response = await fetch(normalizedTarget.price_url, {
        headers: {
          'User-Agent': randomUserAgent
        }
      });

      if (!response.ok) {
        const responseHeaders = getResponseHeadersObject(response);
        const responseHtml = await response.text();

        console.error('[crawler] Non-OK HTML fetch response', {
          url: normalizedTarget.price_url,
          status: response.status,
          statusText: response.statusText || null,
          responseUrl: response.url || normalizedTarget.price_url,
          userAgent: randomUserAgent,
          headers: responseHeaders,
          html: responseHtml
        });

        const error = new Error(`HTTP error! Status: ${response.status}`);
        error.details = {
          url: normalizedTarget.price_url,
          status: response.status,
          statusText: response.statusText || null,
          responseUrl: response.url || normalizedTarget.price_url,
          userAgent: randomUserAgent,
          responseHeaders,
          responseHtml
        };
        finalFailureDetails = {
          responseHtml,
          status: response.status,
          statusText: response.statusText || null,
          responseUrl: response.url || normalizedTarget.price_url,
          userAgent: randomUserAgent,
          responseHeaders
        };
        throw error;
      }

      const html = await response.text();
      if (!html) {
        throw new Error('Empty HTML content');
      }

      return html;
    } catch (error) {
      attempts += 1;
      lastError = error;
      console.warn('[crawler] HTML fetch attempt failed', {
        url: normalizedTarget.price_url,
        attempt: attempts,
        error
      });
    }
  }

  await finalizeHtmlFetchFailure(normalizedTarget, lastError, finalFailureDetails, 'fetch-html', options);
}

async function fetchRenderedHtml(target, options = {}) {
  const normalizedTarget = typeof target === 'string' ? { price_url: target } : target;
  let attempts = 0;
  let lastError = null;
  let finalFailureDetails = null;

  while (attempts < (options.maxAttempts || DEFAULT_MAX_ATTEMPTS)) {
    const browser = await getSharedBrowser();
    const page = await browser.newPage();
    const randomUserAgent = getRandomUserAgent();

    try {
      await page.setUserAgent(randomUserAgent);
      const response = await page.goto(normalizedTarget.price_url, {
        waitUntil: 'networkidle2'
      });
      const navigationDetails = await getPuppeteerPageDiagnostics(page, response);

      if (navigationDetails.status && navigationDetails.status >= 400) {
        console.error('[crawler] Non-OK rendered HTML response', {
          url: normalizedTarget.price_url,
          status: navigationDetails.status,
          statusText: navigationDetails.statusText,
          responseUrl: navigationDetails.responseUrl,
          pageUrl: navigationDetails.pageUrl,
          title: navigationDetails.title,
          userAgent: randomUserAgent,
          headers: navigationDetails.responseHeaders,
          html: navigationDetails.responseHtml
        });

        const error = new Error(`Rendered HTTP error! Status: ${navigationDetails.status}`);
        error.details = {
          url: normalizedTarget.price_url,
          status: navigationDetails.status,
          statusText: navigationDetails.statusText,
          responseUrl: navigationDetails.responseUrl,
          pageUrl: navigationDetails.pageUrl,
          title: navigationDetails.title,
          userAgent: randomUserAgent,
          responseHeaders: navigationDetails.responseHeaders,
          responseHtml: navigationDetails.responseHtml
        };
        finalFailureDetails = {
          status: navigationDetails.status,
          statusText: navigationDetails.statusText,
          responseUrl: navigationDetails.responseUrl,
          pageUrl: navigationDetails.pageUrl,
          title: navigationDetails.title,
          userAgent: randomUserAgent,
          responseHeaders: navigationDetails.responseHeaders,
          responseHtml: navigationDetails.responseHtml
        };
        throw error;
      }

      const html = navigationDetails.responseHtml || await page.content();
      if (!html) {
        throw new Error('Empty HTML content');
      }

      return html;
    } catch (error) {
      attempts += 1;
      lastError = error;
      if (!finalFailureDetails) {
        const failureDetails = await getPuppeteerPageDiagnostics(page).catch(() => ({}));
        finalFailureDetails = {
          status: error && error.details ? error.details.status || null : null,
          statusText: error && error.details ? error.details.statusText || null : null,
          responseUrl: error && error.details ? error.details.responseUrl || null : null,
          pageUrl: failureDetails.pageUrl || null,
          title: failureDetails.title || null,
          userAgent: randomUserAgent,
          responseHeaders: error && error.details ? error.details.responseHeaders || null : null,
          responseHtml: error && error.details && error.details.responseHtml
            ? error.details.responseHtml
            : failureDetails.responseHtml || null
        };
      }
      console.warn('[crawler] Rendered HTML fetch attempt failed', {
        url: normalizedTarget.price_url,
        attempt: attempts,
        error
      });
    } finally {
      await page.close().catch(() => null);
    }
  }

  await finalizeHtmlFetchFailure(normalizedTarget, lastError, finalFailureDetails, 'render-html', options);
}

async function finalizeHtmlFetchFailure(target, lastError, finalFailureDetails, stage, options) {
  let htmlFilePath = null;
  const actionName = typeof options.getActionName === 'function'
    ? options.getActionName(target)
    : (target.action || 'unknown');

  if (
    finalFailureDetails &&
    finalFailureDetails.responseHtml &&
    typeof options.shouldSaveHtml === 'function' &&
    await options.shouldSaveHtml(actionName, true)
  ) {
    htmlFilePath = await options.saveHTMLFile(finalFailureDetails.responseHtml, {
      action: actionName,
      trackId: target.id,
      userId: target.user_id,
      url: target.price_url,
      suffix: stage === 'render-html' ? 'render-failed' : 'fetch-failed'
    });
  }

  const failureLogId = typeof options.logCrawlerFailure === 'function'
    ? await options.logCrawlerFailure(target, stage, lastError, {
      htmlFilePath,
      status: finalFailureDetails ? finalFailureDetails.status : null,
      statusText: finalFailureDetails ? finalFailureDetails.statusText : null,
      responseUrl: finalFailureDetails ? finalFailureDetails.responseUrl : null,
      pageUrl: finalFailureDetails ? finalFailureDetails.pageUrl : null,
      title: finalFailureDetails ? finalFailureDetails.title : null,
      userAgent: finalFailureDetails ? finalFailureDetails.userAgent : null,
      responseHeaders: finalFailureDetails ? finalFailureDetails.responseHeaders : null,
      responseHtml: finalFailureDetails ? finalFailureDetails.responseHtml : null
    })
    : null;

  if (lastError && lastError.details) {
    lastError.details.failureLogId = failureLogId;
    lastError.details.stage = stage;
  } else if (lastError) {
    lastError.details = {
      failureLogId,
      stage
    };
  }

  const finalError = new Error(`Failed to fetch HTML after ${options.maxAttempts || DEFAULT_MAX_ATTEMPTS} attempts: ${lastError.message}`);
  finalError.details = {
    ...(lastError && lastError.details ? lastError.details : {}),
    failureLogId,
    stage
  };
  throw finalError;
}

module.exports = {
  delay,
  fetchHtmlDirect,
  fetchRenderedHtml,
  getPuppeteerPageDiagnostics,
  getRandomUserAgent,
  getSharedBrowser
};

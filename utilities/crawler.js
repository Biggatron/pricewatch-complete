const { JSDOM } = require('jsdom');
const fs = require('fs');
const path = require('path');
const query = require('../db/db');
const keys = require('../config/keys');
const constants = require('../config/const');
const { getAppConfig } = require('./app-config');
const {
  extractDomainFromUrl,
  getFreshDomainAccessProfileByUrl,
  DOMAIN_PROFILE_CRAWLER_MODES,
  DOMAIN_PROFILE_PRICE_LOOKUP_MODES,
  upsertDomainAccessProfile
} = require('./domain-access-profile');
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
const { ensureTrackUniqueActiveIndex } = require('./track-uniqueness');
const {
  deliverPendingEmails: deliverPendingEmailsExternal,
  sendImmediateTemplateEmail: sendImmediateTemplateEmailExternal,
  sendPriceUpdateEmail: queuePriceUpdateEmail,
  sendTemplateTestEmail: sendTemplateTestEmailExternal,
  sendTrackInactiveEmail: queueTrackInactiveEmail
} = require('./email-delivery');
const {
  fetchHtmlDirect,
  fetchRenderedHtml
} = require('./crawler-http');
const {
  cleanupStoredPreviewFiles: cleanupStoredPreviewFilesExternal,
  getPreviewCacheSummary: getPreviewCacheSummaryExternal,
  getUrlPreview: getUrlPreviewExternal
} = require('./preview-cache');
const {
  DOMAIN_PRICE_SELECTOR_TYPES,
  ensureDomainPriceSelectorTable,
  getDomainPriceSelectorsByUrl,
  markDomainPriceSelectorFailure,
  markDomainPriceSelectorSuccess,
  upsertDomainPriceSelector
} = require('./domain-price-selector');
const MAX_MATCH_PRICE = 1000000000;

module.exports = {
  updatePrices,
  extractNumber,
  findAndSavePrices,
  detectTrackByUrl,
  resetInactiveTrackWithCurrentPrice,
  updateSingleTrack,
  getTrackHtmlPreview,
  getUrlPreview: getUrlPreviewExternal,
  deliverPendingEmails: deliverPendingEmailsExternal,
  sendImmediateTemplateEmail: sendImmediateTemplateEmailExternal,
  sendTemplateTestEmail: sendTemplateTestEmailExternal,
  cleanupStoredPreviewFiles: cleanupStoredPreviewFilesExternal,
  getPreviewCacheSummary: getPreviewCacheSummaryExternal
};

function getHtmlFetchOptions() {
  return {
    getActionName,
    logCrawlerFailure,
    saveHTMLFile,
    shouldSaveHtml
  };
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

    const trackGroups = groupTracksByUpdateTarget(result.rows);
    console.info('[crawler] Grouped tracks for update', {
      runId: run.id,
      groupCount: trackGroups.length
    });

    for (const trackGroup of trackGroups) {
      const groupResults = await processTrackUpdateGroup(trackGroup, run.id);

      for (const { track, itemResult } of groupResults) {
        const insertedItem = await persistCrawlerRunItem(run.id, track, itemResult);
        if (itemResult.failureLogId) {
          await updateCrawlerFailureLogLinks(itemResult.failureLogId, {
            run_id: run.id,
            run_item_id: insertedItem.id
          });
        }

        applyRunItemToSummary(summary, itemResult);
      }
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

    const insertedItem = await persistCrawlerRunItem(run.id, track, itemResult);

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
    return fetchRenderedHtml(trackContext, getHtmlFetchOptions());
  }

  return fetchHtmlDirect(trackContext, getHtmlFetchOptions());
}

function groupTracksByUpdateTarget(tracks) {
  const groupedTracks = new Map();

  for (const track of tracks) {
    const groupKey = `${track.requires_javascript ? 'js' : 'html'}::${track.price_url}`;
    if (!groupedTracks.has(groupKey)) {
      groupedTracks.set(groupKey, []);
    }

    groupedTracks.get(groupKey).push(track);
  }

  return Array.from(groupedTracks.values());
}

async function persistCrawlerRunItem(runId, track, itemResult) {
  return insertCrawlerRunItem({
    run_id: runId,
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
}

async function fetchTrackUpdateHtml(track, runId) {
  const trackContext = {
    ...track,
    action: 'update',
    run_id: runId
  };

  const html = track.requires_javascript
    ? await fetchRenderedHtml(trackContext, getHtmlFetchOptions())
    : await fetchHtmlDirect(trackContext, getHtmlFetchOptions());

  return {
    html,
    stage: track.requires_javascript ? 'render-html' : 'fetch-html'
  };
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
      htmlFilePath = await saveHTMLFile(html, {
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
      htmlFilePath = await saveHTMLFile(html, {
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
  const wasInactive = !track.active;
  const priceChanged = !arePricesEqual(match, track.curr_price);

  if (wasInactive) {
    await setTrackAsActive(track, {
      skipHistory: priceChanged
    });
    track.active = true;
  }

  // If tracked price has changed we update database and send email to user
  if (priceChanged) {
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
    const emailDurationMs = await queuePriceUpdateEmail(track, {
      previousPrice
    });
    return {
      status: priceDirection === 'lower' ? 'updated_lower' : priceDirection === 'higher' ? 'updated_higher' : 'updated_other',
      stage: 'find-price',
      previousPrice,
      currentPrice: match,
      priceDirection,
      markedInactive: false,
      reactivated: wasInactive,
      failureLogId: null,
      errorMessage: null,
      emailDurationMs
    };
  }
  if (wasInactive) {
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

function buildSelectorTemplateKey(selectorType, fullyRenderHTML) {
  if (!selectorType) {
    return null;
  }

  return `${selectorType}:${fullyRenderHTML ? 'js' : 'html'}`;
}

function createTrackFromMatch({
  trackRequest,
  fullyRenderHTML,
  matchedPrice,
  priceDiv,
  title,
  displayPriceText = null,
  selectorType = null,
  selectorValue = priceDiv,
  selectorTemplateKey = null
}) {
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
    display_price_text: displayPriceText ? String(displayPriceText).trim() : null,
    selector_type: selectorType || null,
    selector_value: selectorType ? (selectorValue || '') : '',
    selector_template_key: selectorType
      ? (selectorTemplateKey || buildSelectorTemplateKey(selectorType, fullyRenderHTML))
      : null,
    created_at: new Date(),
    last_modified_at: new Date()
  };
}

function escapeCssIdentifier(value) {
  return String(value || '').replace(/[^a-zA-Z0-9_-]/g, (character) => `\\${character.charCodeAt(0).toString(16)} `);
}

function normalizeElementText(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function isStableDomToken(token) {
  const value = String(token || '').trim();
  if (!value || value.length > 48) {
    return false;
  }

  if (!/[a-zA-Z]/.test(value)) {
    return false;
  }

  if (/^css-[a-z0-9_-]{4,}$/i.test(value)) {
    return false;
  }

  if (/^[a-f0-9]{8,}$/i.test(value)) {
    return false;
  }

  if (/\d{5,}/.test(value)) {
    return false;
  }

  return true;
}

function getStableClassNames(element) {
  if (!element || !element.classList) {
    return [];
  }

  return Array.from(element.classList).filter(isStableDomToken);
}

function getStableElementId(element) {
  if (!element || !isStableDomToken(element.id)) {
    return null;
  }

  return element.id;
}

function isUniqueDomSelector(document, selector, expectedElement) {
  if (!selector) {
    return false;
  }

  try {
    const matches = document.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === expectedElement;
  } catch (error) {
    return false;
  }
}

function buildReusableDomSelector(element, document) {
  if (!element || !document) {
    return null;
  }

  const candidateKeys = new Set();
  const candidates = [];
  const tagName = String(element.tagName || '').toLowerCase();
  const elementClassNames = getStableClassNames(element);
  const elementId = getStableElementId(element);

  function addCandidate(type, value) {
    const normalizedValue = String(value || '').trim();
    if (!normalizedValue) {
      return;
    }

    const candidateKey = `${type}:${normalizedValue}`;
    if (candidateKeys.has(candidateKey)) {
      return;
    }

    candidateKeys.add(candidateKey);
    candidates.push({ selectorType: type, selectorValue: normalizedValue });
  }

  for (const className of elementClassNames) {
    addCandidate(DOMAIN_PRICE_SELECTOR_TYPES.CSS, `.${escapeCssIdentifier(className)}`);
  }

  if (elementClassNames.length > 1) {
    addCandidate(
      DOMAIN_PRICE_SELECTOR_TYPES.CSS,
      elementClassNames.map((className) => `.${escapeCssIdentifier(className)}`).join('')
    );
  }

  let ancestor = element.parentElement;
  let depth = 0;
  while (ancestor && depth < 3) {
    const ancestorClassNames = getStableClassNames(ancestor);
    const ancestorId = getStableElementId(ancestor);
    const ancestorSelectors = [];

    if (ancestorId) {
      ancestorSelectors.push(`#${escapeCssIdentifier(ancestorId)}`);
    }

    for (const className of ancestorClassNames) {
      ancestorSelectors.push(`.${escapeCssIdentifier(className)}`);
    }

    if (ancestorClassNames.length > 1) {
      ancestorSelectors.push(
        ancestorClassNames.map((className) => `.${escapeCssIdentifier(className)}`).join('')
      );
    }

    for (const ancestorSelector of ancestorSelectors) {
      for (const className of elementClassNames) {
        addCandidate(
          DOMAIN_PRICE_SELECTOR_TYPES.CSS,
          `${ancestorSelector} .${escapeCssIdentifier(className)}`
        );
      }

      if (elementClassNames.length > 1) {
        addCandidate(
          DOMAIN_PRICE_SELECTOR_TYPES.CSS,
          `${ancestorSelector} ${elementClassNames.map((className) => `.${escapeCssIdentifier(className)}`).join('')}`
        );
      }

      if (tagName) {
        addCandidate(DOMAIN_PRICE_SELECTOR_TYPES.CSS, `${ancestorSelector} ${tagName}`);
      }
    }

    ancestor = ancestor.parentElement;
    depth += 1;
  }

  for (const candidate of candidates) {
    if (candidate.selectorType === DOMAIN_PRICE_SELECTOR_TYPES.CSS
      && isUniqueDomSelector(document, candidate.selectorValue, element)) {
      return candidate;
    }
  }

  if (elementId && isUniqueDomSelector(document, `#${escapeCssIdentifier(elementId)}`, element)) {
    return {
      selectorType: DOMAIN_PRICE_SELECTOR_TYPES.HTML_ID,
      selectorValue: elementId
    };
  }

  return null;
}

function getElementTextCandidates(element) {
  if (!element) {
    return [];
  }

  const directTextRaw = Array.from(element.childNodes || [])
    .filter((node) => node.nodeType === 3)
    .map((node) => node.textContent || '')
    .join(' ');
  const fullTextRaw = element.textContent || '';
  const directText = normalizeElementText(directTextRaw);
  const fullText = normalizeElementText(fullTextRaw);
  const candidates = [];

  if (directText) {
    candidates.push({
      rawText: directTextRaw,
      normalizedText: directText,
      isDirectTextMatch: true
    });
  }

  if (fullText && fullText !== directText) {
    candidates.push({
      rawText: fullTextRaw,
      normalizedText: fullText,
      isDirectTextMatch: false
    });
  }

  return candidates;
}

function getMatchedPriceFromElement(element, expectedPrice = null) {
  for (const candidate of getElementTextCandidates(element)) {
    const matchedPrice = extractNumber(candidate.normalizedText);
    if (!isValidMatchedPrice(matchedPrice)) {
      continue;
    }

    if (expectedPrice != null && !arePricesEqual(matchedPrice, expectedPrice)) {
      continue;
    }

    return {
      matchedPrice,
      matchedText: candidate.normalizedText,
      matchedTextRaw: candidate.rawText,
      isDirectTextMatch: candidate.isDirectTextMatch
    };
  }

  return null;
}

function findBestPriceElement(document, expectedPrice) {
  if (!document) {
    return null;
  }

  let bestMatch = null;

  for (const element of Array.from(document.querySelectorAll('*'))) {
    const tagName = String(element.tagName || '').toLowerCase();
    if (['html', 'head', 'body', 'script', 'style', 'noscript'].includes(tagName)) {
      continue;
    }

    const match = getMatchedPriceFromElement(element, expectedPrice);
    if (!match) {
      continue;
    }

    const reusableSelector = buildReusableDomSelector(element, document);
    const textLength = match.matchedText.length;
    const score = (reusableSelector ? 1000 : 0)
      + (match.isDirectTextMatch ? 500 : 0)
      - Math.min(textLength, 400)
      - (element.children ? element.children.length * 5 : 0);

    if (!bestMatch || score > bestMatch.score) {
      bestMatch = {
        element,
        matchedPrice: match.matchedPrice,
        matchedText: match.matchedText,
        matchedTextRaw: match.matchedTextRaw,
        reusableSelector,
        score
      };
    }
  }

  return bestMatch;
}

function resolvePriceFromDomSelector(document, selector) {
  if (!document || !selector || !selector.selector_type) {
    return null;
  }

  let element = null;

  if (selector.selector_type === DOMAIN_PRICE_SELECTOR_TYPES.CSS) {
    let matches;
    try {
      matches = document.querySelectorAll(selector.selector_value || '');
    } catch (error) {
      return null;
    }

    if (!matches || matches.length !== 1) {
      return null;
    }

    element = matches[0];
  } else if (selector.selector_type === DOMAIN_PRICE_SELECTOR_TYPES.HTML_ID) {
    const elementId = String(selector.selector_value || '').replace(/^#/, '');
    element = document.getElementById(elementId);
  } else {
    return null;
  }

  if (!element) {
    return null;
  }

  const match = getMatchedPriceFromElement(element);
  if (!match) {
    return null;
  }

  return {
    element,
    matchedPrice: match.matchedPrice,
    matchedText: match.matchedText,
    matchedTextRaw: match.matchedTextRaw
  };
}

function findPriceTextLocationInHtml(html, matchedText, rawMatchedText = '') {
  const searchCandidates = [
    String(rawMatchedText || ''),
    String(matchedText || ''),
    normalizeElementText(rawMatchedText || '')
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean);

  for (const candidateText of searchCandidates) {
    let location = html.indexOf(candidateText);
    if (location !== -1) {
      return {
        location,
        matchedText: candidateText
      };
    }

    const nbspCandidate = candidateText.replace(/\s+/g, '&nbsp;').replace(/kr\./g, '');
    location = html.indexOf(nbspCandidate);
    if (location !== -1) {
      return {
        location,
        matchedText: nbspCandidate
      };
    }
  }

  return {
    location: -1,
    matchedText
  };
}

function extractCandidateFromSelector({ trackRequest, selector, document, html, fullyRenderHTML, title }) {
  if (!selector || !selector.selector_type) {
    return null;
  }

  if (selector.selector_type === DOMAIN_PRICE_SELECTOR_TYPES.JSON_LD) {
    const jsonLdProduct = extractProductDataFromJsonLd(html);
    if (!jsonLdProduct || !isValidMatchedPrice(jsonLdProduct.price)) {
      return null;
    }

    return createTrackFromMatch({
      trackRequest,
      fullyRenderHTML,
      matchedPrice: jsonLdProduct.price,
      priceDiv: jsonLdProduct.priceDiv,
      title: jsonLdProduct.name || title,
      selectorType: DOMAIN_PRICE_SELECTOR_TYPES.JSON_LD,
      selectorValue: selector.selector_value || 'Product.offers.price',
      selectorTemplateKey: selector.template_key
    });
  }

  if (selector.selector_type === DOMAIN_PRICE_SELECTOR_TYPES.NEXT_DATA) {
    const nextDataProduct = extractProductDataFromNextData(html);
    if (!nextDataProduct || !isValidMatchedPrice(nextDataProduct.price)) {
      return null;
    }

    return createTrackFromMatch({
      trackRequest,
      fullyRenderHTML,
      matchedPrice: nextDataProduct.price,
      priceDiv: `${NEXT_DATA_PRICE_DIV_PREFIX}${nextDataProduct.priceDiv}`,
      title: nextDataProduct.name || title,
      selectorType: DOMAIN_PRICE_SELECTOR_TYPES.NEXT_DATA,
      selectorValue: selector.selector_value || 'props.pageProps.product.price',
      selectorTemplateKey: selector.template_key
    });
  }

  if (
    selector.selector_type === DOMAIN_PRICE_SELECTOR_TYPES.CSS
    || selector.selector_type === DOMAIN_PRICE_SELECTOR_TYPES.HTML_ID
  ) {
    const resolvedMatch = resolvePriceFromDomSelector(document, selector);
    if (!resolvedMatch || !isValidMatchedPrice(resolvedMatch.matchedPrice)) {
      return null;
    }

    const matchLocation = findPriceTextLocationInHtml(
      html,
      resolvedMatch.matchedText,
      resolvedMatch.matchedTextRaw
    );
    if (matchLocation.location === -1) {
      return null;
    }

    const priceDiv = buildPriceDivFromHtmlMatch(html, matchLocation.location, matchLocation.matchedText);

    return createTrackFromMatch({
      trackRequest,
      fullyRenderHTML,
      matchedPrice: resolvedMatch.matchedPrice,
      priceDiv,
      title,
      displayPriceText: resolvedMatch.matchedTextRaw || resolvedMatch.matchedText,
      selectorType: selector.selector_type,
      selectorValue: selector.selector_value || '',
      selectorTemplateKey: selector.template_key
    });
  }

  return null;
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

  if (!previousActive) {
    return 0;
  }

  return queueTrackInactiveEmail(track);
}

async function setTrackAsActive(track, options = {}) {
  const previousActive = Boolean(track.active);
  const compResult = await query(
    'UPDATE track SET "active" = $1, "last_modified_at" = $2 WHERE "id" = $3',
    [true, new Date(), track.id]
  );
  if (!previousActive && !options.skipHistory) {
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

  const result = await findTrackCandidates(trackRequest);

  if (result.tracks.length === 0) {
    res.status(200).send(result.errorMessage || 'Price not found on page');
    return;
  }

  await addTracksToDatabase(result.tracks, res);
}

async function findTrackCandidates(trackRequest, options = {}) {
  const domainAccessProfile = options.domainAccessProfile || await getFreshDomainAccessProfileByUrl(trackRequest.price_url);
  const preferredPriceLookupMode = options.preferredPriceLookupMode
    || (domainAccessProfile && domainAccessProfile.price_lookup_mode)
    || null;
  const attemptModes = buildTrackCandidateAttemptModes(
    domainAccessProfile && domainAccessProfile.crawler_mode
  );
  let lastResult = {
    tracks: [],
    title: '',
    priceLookupMode: null
  };
  let lastCrawlerMode = null;
  let lastHtml = '';

  for (const crawlerMode of attemptModes) {
    const fullyRenderHTML = crawlerMode === DOMAIN_PROFILE_CRAWLER_MODES.HEADLESS_BROWSER;
    lastCrawlerMode = crawlerMode;
    lastHtml = await getTrackCandidateHtml(trackRequest, fullyRenderHTML);

    if (await shouldSaveHtml('create-track', false)) {
      await saveHTMLFile(lastHtml, {
        action: 'create-track',
        trackId: null,
        userId: trackRequest.user_id,
        url: trackRequest.price_url
      });
    }

    const result = findTrackMatchesInHtml(trackRequest, fullyRenderHTML, lastHtml, {
      preferredPriceLookupMode
    });
    lastResult = result;

    if (result.tracks.length > 0) {
      await upsertDomainAccessProfile({
        url: trackRequest.price_url,
        crawlerMode,
        priceLookupMode: result.priceLookupMode
      });

      return {
        ...result,
        errorMessage: null
      };
    }
  }

  let htmlFilePath = null;
  if (lastHtml && await shouldSaveHtml('create-track', true)) {
    htmlFilePath = await saveHTMLFile(lastHtml, {
      action: 'create-track',
      trackId: null,
      userId: trackRequest.user_id,
      url: trackRequest.price_url,
      suffix: 'price-not-found'
    });
  }

  if (options.logFailures !== false) {
    await addFailedTrackLog(trackRequest, lastResult.title);
    await logCrawlerFailure(trackRequest, 'find-original-price', new Error('Price not found on page'), {
      htmlFilePath,
      fullyRenderHTML: lastCrawlerMode === DOMAIN_PROFILE_CRAWLER_MODES.HEADLESS_BROWSER
    });
  }

  console.warn('[crawler] Could not find price on page', {
    url: trackRequest.price_url,
    price: trackRequest.orig_price,
    attemptedCrawlerModes: attemptModes
  });

  return {
    ...lastResult,
    errorMessage: 'Price not found on page'
  };
}

async function detectTrackByUrl(trackRequest) {
  await ensureDomainPriceSelectorTable();

  const selectors = await getDomainPriceSelectorsByUrl(trackRequest.price_url);
  if (!selectors || selectors.length === 0) {
    return {
      success: false,
      reason: 'no_selector'
    };
  }

  return detectTrackBySelectors(trackRequest, selectors);
}

async function detectTrackBySelectors(trackRequest, selectors) {
  for (const selector of selectors) {
    try {
      const fullyRenderHTML = Boolean(selector.requires_javascript);
      const html = fullyRenderHTML
        ? await fetchRenderedHtml({
          ...trackRequest,
          action: 'detect-track',
          requires_javascript: true
        }, getHtmlFetchOptions())
        : await fetchHtmlDirect({
          ...trackRequest,
          action: 'detect-track',
          requires_javascript: false
        }, getHtmlFetchOptions());

      const dom = new JSDOM(html);
      const document = dom.window.document;
      const title = document.querySelector('title')
        ? document.querySelector('title').textContent || ''
        : '';
      const track = extractCandidateFromSelector({
        trackRequest,
        selector,
        document,
        html,
        fullyRenderHTML,
        title
      });

      if (!track) {
        await markDomainPriceSelectorFailure(selector.id);
        continue;
      }

      await markDomainPriceSelectorSuccess(selector.id);
      return {
        success: true,
        selector,
        track
      };
    } catch (error) {
      console.warn('[crawler] Stored selector detection failed', {
        url: trackRequest.price_url,
        selectorId: selector.id,
        selectorType: selector.selector_type,
        error
      });
      await markDomainPriceSelectorFailure(selector.id).catch(() => null);
    }
  }

  return {
    success: false,
    reason: 'selector_failed'
  };
}

function buildTrackCandidateAttemptModes(preferredCrawlerMode) {
  const defaultModes = [
    DOMAIN_PROFILE_CRAWLER_MODES.DIRECT_HTML,
    DOMAIN_PROFILE_CRAWLER_MODES.HEADLESS_BROWSER
  ];

  if (!preferredCrawlerMode || !defaultModes.includes(preferredCrawlerMode)) {
    return defaultModes;
  }

  return [
    preferredCrawlerMode,
    ...defaultModes.filter((mode) => mode !== preferredCrawlerMode)
  ];
}

async function getTrackCandidateHtml(trackRequest, fullyRenderHTML) {
  if (fullyRenderHTML) {
    return fetchRenderedHtml({
      ...trackRequest,
      action: 'create-track',
      requires_javascript: true
    }, getHtmlFetchOptions());
  }

  return fetchHtmlDirect({
    ...trackRequest,
    action: 'create-track',
    requires_javascript: false
  }, getHtmlFetchOptions());
}

function findTrackMatchesInHtml(trackRequest, fullyRenderHTML, html, options = {}) {
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

  const matcherSequence = buildPriceLookupMatcherSequence(options.preferredPriceLookupMode);

  for (const matcher of matcherSequence) {
    const result = matcher({
      trackRequest,
      fullyRenderHTML,
      html,
      title,
      document
    });

    if (result.tracks.length > 0) {
      return result;
    }
  }

  return {
    tracks: [],
    title,
    priceLookupMode: null
  };
}

function buildPriceLookupMatcherSequence(preferredPriceLookupMode) {
  const matcherMap = {
    [DOMAIN_PROFILE_PRICE_LOOKUP_MODES.DIV_STRUCTURE]: findTrackMatchesByDivStructure,
    [DOMAIN_PROFILE_PRICE_LOOKUP_MODES.STRING_MATCH]: findTrackMatchesByStringMatch
  };
  const defaultOrder = [
    DOMAIN_PROFILE_PRICE_LOOKUP_MODES.DIV_STRUCTURE,
    DOMAIN_PROFILE_PRICE_LOOKUP_MODES.STRING_MATCH
  ];

  if (!preferredPriceLookupMode || !matcherMap[preferredPriceLookupMode]) {
    return defaultOrder.map((mode) => matcherMap[mode]);
  }

  return [
    matcherMap[preferredPriceLookupMode],
    ...defaultOrder
      .filter((mode) => mode !== preferredPriceLookupMode)
      .map((mode) => matcherMap[mode])
  ];
}

function findTrackMatchesByDivStructure({ trackRequest, fullyRenderHTML, html, title, document }) {
  const jsonLdProduct = extractProductDataFromJsonLd(html);
  if (jsonLdProduct && isValidMatchedPrice(jsonLdProduct.price) && arePricesEqual(jsonLdProduct.price, trackRequest.orig_price)) {
    console.info('[crawler] Found original price in JSON-LD product schema', {
      url: trackRequest.price_url,
      price: jsonLdProduct.price
    });
    return {
      tracks: [
        createTrackFromMatch({
          trackRequest,
          fullyRenderHTML,
          matchedPrice: jsonLdProduct.price,
          priceDiv: jsonLdProduct.priceDiv,
          title: jsonLdProduct.name || title,
          selectorType: DOMAIN_PRICE_SELECTOR_TYPES.JSON_LD,
          selectorValue: 'Product.offers.price'
        })
      ],
      title,
      priceLookupMode: DOMAIN_PROFILE_PRICE_LOOKUP_MODES.DIV_STRUCTURE
    };
  }

  const nextDataProduct = extractProductDataFromNextData(html);
  if (nextDataProduct && isValidMatchedPrice(nextDataProduct.price) && arePricesEqual(nextDataProduct.price, trackRequest.orig_price)) {
    console.info('[crawler] Found original price in Next.js __NEXT_DATA__ payload', {
      url: trackRequest.price_url,
      price: nextDataProduct.price
    });
    return {
      tracks: [
        createTrackFromMatch({
          trackRequest,
          fullyRenderHTML,
          matchedPrice: nextDataProduct.price,
          priceDiv: `${NEXT_DATA_PRICE_DIV_PREFIX}${nextDataProduct.priceDiv}`,
          title: nextDataProduct.name || title,
          selectorType: DOMAIN_PRICE_SELECTOR_TYPES.NEXT_DATA,
          selectorValue: 'props.pageProps.product.price'
        })
      ],
      title,
      priceLookupMode: DOMAIN_PROFILE_PRICE_LOOKUP_MODES.DIV_STRUCTURE
    };
  }

  const priceElementMatch = findBestPriceElement(document, trackRequest.orig_price);

  console.info('[crawler] Looking for original price on page using div structure', {
    url: trackRequest.price_url,
    price: trackRequest.orig_price,
    elementCount: document.querySelectorAll('*').length,
    fullyRenderHTML
  });

  if (!priceElementMatch) {
    return {
      tracks: [],
      title,
      priceLookupMode: null
    };
  }

  const matchLocation = findPriceTextLocationInHtml(
    html,
    priceElementMatch.matchedText,
    priceElementMatch.matchedTextRaw
  );
  if (matchLocation.location === -1) {
    console.warn('[crawler] Matching price text found but location lookup failed', {
      url: trackRequest.price_url,
      candidatePrice: priceElementMatch.matchedText
    });
    return {
      tracks: [],
      title,
      priceLookupMode: null
    };
  }

  const priceDiv = buildPriceDivFromHtmlMatch(html, matchLocation.location, matchLocation.matchedText);

  return {
    tracks: [
      createTrackFromMatch({
        trackRequest,
        fullyRenderHTML,
        matchedPrice: priceElementMatch.matchedPrice,
        priceDiv,
        title,
        displayPriceText: priceElementMatch.matchedTextRaw || priceElementMatch.matchedText,
        selectorType: priceElementMatch.reusableSelector
          ? priceElementMatch.reusableSelector.selectorType
          : null,
        selectorValue: priceElementMatch.reusableSelector
          ? priceElementMatch.reusableSelector.selectorValue
          : ''
      })
    ],
    title,
    priceLookupMode: DOMAIN_PROFILE_PRICE_LOOKUP_MODES.DIV_STRUCTURE
  };
}

function findTrackMatchesByStringMatch({ trackRequest, fullyRenderHTML, html, title, document }) {
  const candidatePattern = /(^|[^\d])([\d][\d\s.,]{0,30}\d|\d)(?!\d)/g;
  let match;

  console.info('[crawler] Looking for original price on page using string match', {
    url: trackRequest.price_url,
    price: trackRequest.orig_price,
    fullyRenderHTML
  });

  while ((match = candidatePattern.exec(html)) !== null) {
    const matchedPriceText = match[2];
    const matchedPrice = extractNumber(matchedPriceText);

    if (!isValidMatchedPrice(matchedPrice) || !arePricesEqual(matchedPrice, trackRequest.orig_price)) {
      continue;
    }

    const matchOffset = match[0].indexOf(matchedPriceText);
    const matchIndex = match.index + (matchOffset >= 0 ? matchOffset : 0);
    const priceDiv = buildPriceDivFromHtmlMatch(html, matchIndex, matchedPriceText);
    const priceElementMatch = findBestPriceElement(document, matchedPrice);

    return {
      tracks: [
        createTrackFromMatch({
          trackRequest,
          fullyRenderHTML,
          matchedPrice,
          priceDiv,
          title,
          displayPriceText: priceElementMatch
            ? (priceElementMatch.matchedTextRaw || priceElementMatch.matchedText)
            : matchedPriceText,
          selectorType: priceElementMatch && priceElementMatch.reusableSelector
            ? priceElementMatch.reusableSelector.selectorType
            : null,
          selectorValue: priceElementMatch && priceElementMatch.reusableSelector
            ? priceElementMatch.reusableSelector.selectorValue
            : ''
        })
      ],
      title,
      priceLookupMode: DOMAIN_PROFILE_PRICE_LOOKUP_MODES.STRING_MATCH
    };
  }

  return {
    tracks: [],
    title,
    priceLookupMode: null
  };
}

function buildPriceDivFromHtmlMatch(html, htmlPriceLocation, matchedPriceText) {
  const startPos = Math.max(0, htmlPriceLocation - 500);
  const endPos = Math.min(html.length, htmlPriceLocation + matchedPriceText.length + 500);
  const priceDiv = html.substring(startPos, endPos);
  const matchPlaceholder = `__PRICE_MATCH_${Date.now()}__`;
  let escapedPriceDiv = escapeRegex(priceDiv.replace(matchedPriceText, matchPlaceholder));
  escapedPriceDiv = escapedPriceDiv.replace(matchPlaceholder, '(.*?)');
  return escapedPriceDiv.trim();
}

async function resetInactiveTrackWithCurrentPrice(existingTrack, currentPrice) {
  if (!isValidMatchedPrice(currentPrice)) {
    return {
      success: false,
      code: 'INVALID_PRICE',
      error: 'Price is required and must be a valid numeric value'
    };
  }

  const trackRequest = {
    price_url: existingTrack.price_url,
    orig_price: currentPrice,
    email: existingTrack.email,
    user_id: existingTrack.user_id
  };
  const result = await findTrackCandidates(trackRequest, {
    logFailures: false
  });

  if (result.tracks.length === 0) {
    return {
      success: false,
      code: 'PRICE_NOT_FOUND',
      error: result.errorMessage || 'Price not found on page'
    };
  }

  const resetTrack = result.tracks[0];
  if (!isValidMatchedPrice(resetTrack.orig_price) || !isValidMatchedPrice(resetTrack.curr_price)) {
    return {
      success: false,
      code: 'INVALID_MATCH',
      error: 'The located price was not valid'
    };
  }

  resetTrack.product_name = (resetTrack.product_name || '').substring(0, 63);
  const previousPrice = existingTrack.curr_price;
  const previousActive = Boolean(existingTrack.active);
  const updatedAt = new Date();
  const updateResult = await query(
    'UPDATE track SET "orig_price" = $1, "curr_price" = $2, "requires_javascript" = $3, "price_div" = $4, "product_name" = $5, "active" = $6, "last_modified_at" = $7 WHERE "id" = $8 RETURNING *',
    [
      resetTrack.orig_price,
      resetTrack.curr_price,
      resetTrack.requires_javascript,
      resetTrack.price_div,
      resetTrack.product_name,
      true,
      updatedAt,
      existingTrack.id
    ]
  );
  const updatedTrack = updateResult.rows[0];

  if (!updatedTrack) {
    return {
      success: false,
      code: 'UPDATE_FAILED',
      error: 'Failed to reactivate track'
    };
  }

  if (
    Number(existingTrack.curr_price) !== Number(resetTrack.curr_price) ||
    !previousActive
  ) {
    await insertTrackHistoryEntry({
      trackId: existingTrack.id,
      priceBefore: existingTrack.curr_price,
      priceAfter: resetTrack.curr_price,
      active: true,
      changedAt: updatedAt
    });
  }

  await learnSelectorAndReactivate(resetTrack, existingTrack.id);

  return {
    success: true,
    track: updatedTrack,
    previousPrice,
    currentPrice: resetTrack.curr_price,
    reactivated: !previousActive
  };
}

async function addFailedTrackLog(trackRequest) {
  const domain = extractDomainFromUrl(trackRequest.price_url);
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

async function learnSelectorAndReactivate(track, sourceTrackId) {
  if (!track || !track.selector_type) {
    return null;
  }

  const selectorRecord = await upsertDomainPriceSelector({
    url: track.price_url,
    templateKey: track.selector_template_key || buildSelectorTemplateKey(track.selector_type, track.requires_javascript),
    selectorType: track.selector_type,
    selectorValue: track.selector_value || track.price_div || '',
    requiresJavascript: Boolean(track.requires_javascript),
    sourceTrackId
  });

  if (!selectorRecord) {
    return null;
  }

  await reactivateInactiveTracksForSelector(track, selectorRecord, {
    sourceTrackId
  });

  return selectorRecord;
}

function trackCanUseLearnedSelector(track, selectorRecord) {
  if (!track || !selectorRecord) {
    return false;
  }

  if (Boolean(track.requires_javascript) !== Boolean(selectorRecord.requires_javascript)) {
    return false;
  }

  if (selectorRecord.selector_type === DOMAIN_PRICE_SELECTOR_TYPES.NEXT_DATA) {
    return trackUsesNextDataPriceDiv(track);
  }

  return true;
}

async function reactivateInactiveTracksForSelector(track, selectorRecord, options = {}) {
  const domain = extractDomainFromUrl(track && track.price_url);
  if (!domain || !selectorRecord) {
    return 0;
  }

  const result = await query(
    `SELECT *
     FROM track
     WHERE active = FALSE
       AND deleted = FALSE
       AND id <> COALESCE($2, -1)
       AND requires_javascript = $3
       AND REPLACE(LOWER(split_part(split_part(price_url, '://', 2), '/', 1)), 'www.', '') = $1
     ORDER BY COALESCE(last_modified_at, created_at) DESC NULLS LAST, id DESC`,
    [domain, options.sourceTrackId || null, Boolean(selectorRecord.requires_javascript)]
  );

  let reactivatedCount = 0;

  for (const inactiveTrack of result.rows) {
    if (!trackCanUseLearnedSelector(inactiveTrack, selectorRecord)) {
      continue;
    }

    const detectionResult = await detectTrackBySelectors({
      price_url: inactiveTrack.price_url,
      user_id: inactiveTrack.user_id,
      email: inactiveTrack.email
    }, [selectorRecord]);

    if (!detectionResult || !detectionResult.success || !detectionResult.track) {
      continue;
    }

    const detectedTrack = detectionResult.track;
    detectedTrack.product_name = (detectedTrack.product_name || inactiveTrack.product_name || '').substring(0, 63);
    const updatedAt = new Date();
    const updateResult = await query(
      `UPDATE track
       SET curr_price = $1,
           requires_javascript = $2,
           price_div = $3,
           product_name = $4,
           active = TRUE,
           last_modified_at = $5
       WHERE id = $6
       RETURNING *`,
      [
        detectedTrack.curr_price,
        detectedTrack.requires_javascript,
        detectedTrack.price_div,
        detectedTrack.product_name,
        updatedAt,
        inactiveTrack.id
      ]
    );

    if (!updateResult.rows[0]) {
      continue;
    }

    if (
      Number(inactiveTrack.curr_price) !== Number(detectedTrack.curr_price) ||
      !Boolean(inactiveTrack.active)
    ) {
      await insertTrackHistoryEntry({
        trackId: inactiveTrack.id,
        priceBefore: inactiveTrack.curr_price,
        priceAfter: detectedTrack.curr_price,
        active: true,
        changedAt: updatedAt
      });
    }

    reactivatedCount += 1;
  }

  if (reactivatedCount > 0) {
    console.info('[crawler] Inactive tracks reactivated from learned selector', {
      domain,
      selectorId: selectorRecord.id,
      selectorType: selectorRecord.selector_type,
      reactivatedCount
    });
  }

  return reactivatedCount;
}


async function addTracksToDatabase(tracks, res) {
  await ensureTrackSoftDeleteColumn();
  await ensureTrackUniqueActiveIndex();

  console.info('[crawler] Saving tracks to database', {
    trackCount: tracks.length
  });
  let insertedTrackCount = 0;
  let existingTrackCount = 0;

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
      existingTrackCount += 1;
      const updateResult = await updateExistingTrack(existingTrack, track);
      if (updateResult.rows[0] && updateResult.rows[0].id) {
        await learnSelectorAndReactivate(track, existingTrack.id);
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
      }
    } else {
      try {
        const insertResult = await query(
          'INSERT INTO track (orig_price, curr_price, requires_javascript, price_url, price_div, product_name, user_id, email, active, created_at, last_modified_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *',
          [ track.orig_price, track.curr_price, track.requires_javascript, track.price_url, track.price_div, track.product_name, track.user_id, track.email, track.active, track.created_at, track.last_modified_at ]
        );
        if (insertResult.rows[0].id) {
          await learnSelectorAndReactivate(track, insertResult.rows[0].id);
          await insertTrackHistoryEntry({
            trackId: insertResult.rows[0].id,
            priceBefore: null,
            priceAfter: track.curr_price,
            active: Boolean(track.active)
          });
          ++insertedTrackCount;
        }
      } catch (error) {
        if (!error || error.code !== '23505') {
          throw error;
        }

        const concurrentExistingTrack = await trackExists(track);
        if (!concurrentExistingTrack) {
          throw error;
        }

        existingTrackCount += 1;
        const updateResult = await updateExistingTrack(concurrentExistingTrack, track);
        if (updateResult.rows[0] && updateResult.rows[0].id) {
          await learnSelectorAndReactivate(track, concurrentExistingTrack.id);
        }
        if (
          updateResult.rows[0] &&
          updateResult.rows[0].id &&
          (
            Number(concurrentExistingTrack.curr_price) !== Number(track.curr_price) ||
            Boolean(concurrentExistingTrack.active) !== Boolean(track.active)
          )
        ) {
          await insertTrackHistoryEntry({
            trackId: concurrentExistingTrack.id,
            priceBefore: concurrentExistingTrack.curr_price,
            priceAfter: track.curr_price,
            active: Boolean(track.active)
          });
        }
      }
    }
  }

  if (insertedTrackCount === 0 && existingTrackCount === 0) {
    res.status(500).json({ error: 'Error saving track to database' });
  } else if (insertedTrackCount > 0 && existingTrackCount === 0) {
    res.status(201).json({
      message: insertedTrackCount === 1
        ? 'Track added successfully'
        : `${insertedTrackCount} tracks added successfully`
    });
  } else if (insertedTrackCount === 0 && existingTrackCount > 0) {
    res.status(200).json({
      message: 'You are already tracking this product',
      code: 'TRACK_EXISTS'
    });
  } else if ((insertedTrackCount + existingTrackCount) < tracks.length) {
    res.status(206).json({
      message: `${insertedTrackCount} out of ${tracks.length} saved to database`,
      insertedTrackCount,
      existingTrackCount
    });
  } else {
    res.status(201).json({
      message: `${insertedTrackCount} tracks added successfully`,
      insertedTrackCount,
      existingTrackCount
    });
  }
}

async function trackExists(track) {
  await ensureTrackSoftDeleteColumn();
  await ensureTrackUniqueActiveIndex();

  let existingTrackResult = await query(
    `SELECT *
     FROM track
     WHERE user_id = $1
       AND price_url = $2
       AND deleted = FALSE
     ORDER BY COALESCE(last_modified_at, created_at) DESC NULLS LAST, id DESC`,
    [track.user_id, track.price_url]
  );
  return existingTrackResult.rows[0];
}

async function updateExistingTrack(existingTrack, track) {
  return query(
    'UPDATE track SET "curr_price" = $1, "last_modified_at" = $2, "price_div" = $3, "product_name" = $4, "active" = $5, "requires_javascript" = $6 WHERE "id" = $7 RETURNING *',
    [track.curr_price, new Date(), track.price_div, track.product_name, track.active, track.requires_javascript, existingTrack.id]
  );
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

function extractNumber(price) {
  const rawValue = String(price == null ? '' : price).trim();
  if (!rawValue) {
    return '';
  }

  const cleanedValue = rawValue
    .replace(/\s+/g, '')
    .replace(/[^\d.,-]/g, '')
    .replace(/(?!^)-/g, '');

  if (!cleanedValue) {
    return '';
  }

  const commaCount = (cleanedValue.match(/,/g) || []).length;
  const dotCount = (cleanedValue.match(/\./g) || []).length;
  let normalized = cleanedValue;

  if (commaCount > 0 && dotCount > 0) {
    const lastCommaIndex = normalized.lastIndexOf(',');
    const lastDotIndex = normalized.lastIndexOf('.');
    const decimalSeparator = lastCommaIndex > lastDotIndex ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';

    normalized = normalized.split(thousandsSeparator).join('');
    if (decimalSeparator === ',') {
      normalized = normalized.replace(',', '.');
    }
  } else if (commaCount > 0 || dotCount > 0) {
    const separator = commaCount > 0 ? ',' : '.';
    const parts = normalized.split(separator);

    if (parts.length === 2) {
      const trailingDigits = parts[1];
      if (trailingDigits.length >= 1 && trailingDigits.length <= 2) {
        normalized = `${parts[0]}.${trailingDigits}`;
      } else {
        normalized = parts.join('');
      }
    } else {
      const trailingDigits = parts[parts.length - 1];
      if (trailingDigits.length >= 1 && trailingDigits.length <= 2) {
        normalized = `${parts.slice(0, -1).join('')}.${trailingDigits}`;
      } else {
        normalized = parts.join('');
      }
    }
  }

  normalized = normalized.replace(/(?!^)-/g, '');

  if (normalized.startsWith('.')) {
    normalized = `0${normalized}`;
  }

  if (normalized.startsWith('-.')) {
    normalized = normalized.replace('-.', '-0.');
  }

  if (!isNumeric(normalized)) {
    return '';
  }

  return normalized;
}

function escapeRegex(string) {
  return string.replace(/[/\-\\^$*+?.()|[\]{}]/g, '\\$&');
}

function isNumeric(value) {
  return /^-?\d+(?:\.\d+)?$/.test(String(value));
}

function isValidMatchedPrice(value) {
  const normalizedValue = String(value == null ? '' : value);
  const digitCount = normalizedValue.replace(/\D/g, '').length;
  return isNumeric(normalizedValue) && digitCount <= 20 && Number(normalizedValue) <= MAX_MATCH_PRICE;
}

function arePricesEqual(left, right) {
  if (!isNumeric(left) || !isNumeric(right)) {
    return false;
  }

  return Number(left) === Number(right);
}

async function saveHTMLFile(html, metadata) {
  const fileName = buildHtmlFilePath(metadata);
  fs.mkdirSync(path.dirname(fileName), { recursive: true });

  try {
    await fs.promises.writeFile(fileName, html, 'utf8');
    console.info('[crawler] HTML file saved', {
      fileName,
      action: metadata.action,
      trackId: metadata.trackId || null
    });
  } catch (error) {
    console.error('[crawler] Failed to save HTML file', {
      fileName,
      action: metadata.action,
      trackId: metadata.trackId || null,
      error
    });
    throw error;
  }

  return fileName;
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
    const fetchResult = await fetchTrackUpdateHtml(track, runId);
    if (await shouldSaveHtml('update', false)) {
      await saveHTMLFile(fetchResult.html, {
        action: 'update',
        trackId: track.id,
        userId: track.user_id,
        url: track.price_url
      });
    }

    itemResult = await processTrackUpdateWithFetchedHtml(
      track,
      runId,
      fetchResult.html,
      fetchResult.stage,
      itemResult
    );
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

async function processTrackUpdateGroup(trackGroup, runId) {
  if (!trackGroup || trackGroup.length === 0) {
    return [];
  }

  const sharedTrack = trackGroup[0];
  let fetchResult = null;

  try {
    fetchResult = await fetchTrackUpdateHtml(sharedTrack, runId);
  } catch (error) {
    const failedResults = [];
    for (let i = 0; i < trackGroup.length; i++) {
      const track = trackGroup[i];
      let itemResult = createRunItemResult(track);
      const trackScopedError = i === 0 ? error : cloneTrackUpdateError(error);

      try {
        itemResult = await handleUnexpectedTrackError(track, runId, trackScopedError, itemResult);
      } catch (nestedError) {
        console.error('[crawler] Track group failure handling failed', {
          runId,
          trackId: track.id,
          url: track.price_url,
          error: nestedError
        });
        itemResult = {
          ...itemResult,
          status: 'fetch_failed',
          stage: track.requires_javascript ? 'render-html' : 'fetch-html',
          errorMessage: nestedError && nestedError.message ? nestedError.message : 'Unexpected crawler error'
        };
      }

      console.error('[crawler] Shared track fetch failed', {
        runId,
        trackId: track.id,
        url: track.price_url,
        error
      });
      itemResult.durationMs = Math.max(0, itemResult.durationMs || 0);
      failedResults.push({ track, itemResult });
    }

    return failedResults;
  }

  if (await shouldSaveHtml('update', false)) {
    await saveHTMLFile(fetchResult.html, {
      action: 'update',
      trackId: sharedTrack.id,
      userId: sharedTrack.user_id,
      url: sharedTrack.price_url,
      suffix: 'shared-fetch'
    });
  }

  const groupResults = [];
  for (const track of trackGroup) {
    const startedAt = Date.now();
    let itemResult = createRunItemResult(track);

    try {
      itemResult = await processTrackUpdateWithFetchedHtml(
        track,
        runId,
        fetchResult.html,
        fetchResult.stage,
        itemResult
      );
    } catch (error) {
      itemResult = await handleUnexpectedTrackError(track, runId, error, itemResult);

      console.error('[crawler] Track processing with shared HTML failed', {
        runId,
        trackId: track.id,
        url: track.price_url,
        error
      });
    }

    itemResult.durationMs = Math.max(0, Date.now() - startedAt - (itemResult.emailDurationMs || 0));
    groupResults.push({ track, itemResult });
  }

  return groupResults;
}

async function processTrackUpdateWithFetchedHtml(track, runId, html, stage, baseItemResult = null) {
  const trackContext = {
    ...track,
    action: 'update',
    run_id: runId
  };

  let itemResult = {
    ...(baseItemResult || createRunItemResult(track)),
    htmlLookupSuccess: true,
    stage
  };

  itemResult = {
    ...itemResult,
    ...(await findPriceFromDiv(html, trackContext))
  };

  return itemResult;
}

function cloneTrackUpdateError(error) {
  const clonedError = new Error(error && error.message ? error.message : 'Unexpected crawler error');

  if (error && error.stack) {
    clonedError.stack = error.stack;
  }

  if (error && error.details) {
    clonedError.details = {
      ...error.details,
      failureLogId: null
    };
  }

  return clonedError;
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


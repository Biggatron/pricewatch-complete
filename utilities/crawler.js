const puppeteer = require('puppeteer');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { JSDOM } = require('jsdom');
const fs = require('fs');
const query = require('../db/db');
const keys = require('../config/keys');
const constants = require('../config/const');
const nodemailer = require('nodemailer');
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

module.exports = {
  updatePrices,
  extractNumber,
  findAndSavePrices,
  updateSingleTrack,
  getTrackHtmlPreview
};

function updatePrices(options = {}) {
  const startedAt = Date.now();
  console.info('[crawler] Update job started');
  return getAndUpdatePrices(options).catch((error) => {
    console.error('[crawler] Update job failed', {
      durationMs: Date.now() - startedAt,
      error
    });
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

  try {
    const result = await query(
      `SELECT * FROM track WHERE active = true or (last_modified_at >= NOW() - INTERVAL '7 days')`
    );
    console.info('[crawler] Loaded tracks for update', {
      runId: run.id,
      trackCount: result.rows.length
    });

    for (let i = 0; i < result.rows.length; i++) {
      const track = result.rows[i];
      const itemResult = await processTrackUpdate(track, run.id);

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
  }
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
  const itemResult = await processTrackUpdate(track, run.id);

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

  applyRunItemToSummary(summary, itemResult);
  summary.status = summary.error_count > 0 ? 'partial' : 'success';
  summary.finished_at = new Date();
  summary.duration_ms = summary.finished_at.getTime() - summary.started_at.getTime();

  await finalizeCrawlerRun(run.id, summary);

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
  fs.writeFile(fileName, html, function(err) {
    if (err) throw err;
    console.info('[crawler] HTML file saved', {
      fileName,
      action: metadata.action,
      trackId: metadata.trackId || null
    });
  });
  return fileName;
}

async function findPriceFromDiv(html, track) {
  console.info('[crawler] Looking for updated price', {
    id: track.id,
    productName: track.product_name
  });
  const jsonLdPrice = extractPriceFromJsonLd(html);
  if (isNumeric(jsonLdPrice)) {
    console.info('[crawler] Found price in JSON-LD product schema', {
      id: track.id,
      productName: track.product_name,
      price: jsonLdPrice
    });
    return handleMatchedPrice(jsonLdPrice, track);
  }

  let priceDivBeforeAfter = [];
  const htmlMinMatchSize = await getAppConfig('crawler.html_min_match_size', constants.crawler.htmlMinMatchSize);

  // Try to find exact match
  let matches = html.match(track.price_div);

  // If exact match failes then try matching html before price, then after price
  // This can happen when price is discounted and a before price or a discount percentage div is added
  if (!matches || !matches[1]) {
    priceDivBeforeAfter = track.price_div.split("(.*?)");
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
    await setTrackAsInactive(track);
    return {
      status: 'match_failed',
      stage: 'find-price',
      previousPrice: track.curr_price,
      currentPrice: null,
      priceDirection: null,
      markedInactive: true,
      reactivated: false,
      failureLogId,
      errorMessage: 'Price match not found'
    };
  } 

  // If numer has more than 20 digits then something went wrong in matching
  let match = extractNumber(matches[1]);
  if (match.length > 20) {
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
    await setTrackAsInactive(track);
    return {
      status: 'non_numeric_match',
      stage: 'find-price',
      previousPrice: track.curr_price,
      currentPrice: null,
      priceDirection: null,
      markedInactive: true,
      reactivated: false,
      failureLogId,
      errorMessage: 'Extracted match was not numeric'
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
    await sendPriceUpdateEmail(track);
    return {
      status: priceDirection === 'lower' ? 'updated_lower' : priceDirection === 'higher' ? 'updated_higher' : 'updated_other',
      stage: 'find-price',
      previousPrice,
      currentPrice: match,
      priceDirection,
      markedInactive: false,
      reactivated: false,
      failureLogId: null,
      errorMessage: null
    };
  }

  console.info('[crawler] Price unchanged', {
    id: track.id,
    price: match
  });

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
  const compResult = await query(
    'UPDATE track SET "active" = $1, "last_modified_at" = $2 WHERE "id" = $3',
    [false, new Date(), track.id]
  );
  console.warn('[crawler] Track marked inactive', {
    id: track.id,
    productName: track.product_name
  });
  await sendTrackInactiveEmail(track);
}

async function setTrackAsActive(track) {
  const compResult = await query(
    'UPDATE track SET "active" = $1, "last_modified_at" = $2 WHERE "id" = $3',
    [true, new Date(), track.id]
  );
}

async function findAndSavePrices(trackRequest, fullyRenderHTML, res) {
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
  if (jsonLdProduct && jsonLdProduct.price === trackRequest.orig_price) {
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
  console.info('[crawler] Saving tracks to database', {
    trackCount: tracks.length
  });
  let trackInsertCount = 0;

  // Loop through tracks and add/update database
  for (let i = 0; i < tracks.length; i++) {
    let track = tracks[i];
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
        ++trackInsertCount;
      }
    } else {
      const insertResult = await query(
        'INSERT INTO track (orig_price, curr_price, requires_javascript, price_url, price_div, product_name, user_id, email, active, created_at, last_modified_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *',
        [ track.orig_price, track.curr_price, track.requires_javascript, track.price_url, track.price_div, track.product_name, track.user_id, track.email, track.active, track.created_at, track.last_modified_at ]
      );
      if (insertResult.rows[0].id) {
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
  let existingTrackResult = await query(
    `SELECT * FROM track WHERE user_id = $1 and price_url = $2 ORDER BY created_at DESC`,
    [track.user_id, track.price_url]
  );
  return existingTrackResult.rows[0];
}

async function updatePrice(newPrice, track) {
  const compResult = await query(
    'UPDATE track SET "curr_price" = $1, "last_modified_at" = $2 WHERE "id" = $3',
    [newPrice, new Date(), track.id]
  );
}

async function sendEmail(email) {
  const sendEmailsEnabled = await getAppConfig('email.send_enabled', constants.email.sendEmail);
  if (sendEmailsEnabled) {
    try {
      const emailService = await getAppConfig('email.service', keys.email && keys.email.service);
      const emailAddress = await getAppConfig('email.address', keys.email && keys.email.address);
      const emailPassword = await getAppConfig('email.password', keys.email && keys.email.password);

      // Create a transporter
      const transporter = nodemailer.createTransport({
        service: emailService,
        auth: {
          user: emailAddress, 
          pass: emailPassword,   // App password or your email password
        },
      });

      // Email options
      const mailOptions = {
        from: emailAddress, // Sender email
        to: email.email,          // Recipient email
        subject: email.subject,   // Email subject
        text: email.body,         // Plain text message
      };

      // Send the email
      const info = await transporter.sendMail(mailOptions);
      
      // Email sent successfully
      email.delivered = true;
      console.info('[crawler] Email sent', {
        trackId: email.track_id,
        recipient: email.email,
        response: info.response
      });
    } catch (error) {
      console.error('[crawler] Failed to send email', {
        trackId: email.track_id,
        recipient: email.email,
        subject: email.subject,
        error
      });
    }
  }
  await insertEmail(email);
}

async function sendPriceUpdateEmail(track) {
  let email = {
    track_id: track.id,
    product_name: track.product_name,
    orig_price: track.orig_price,
    curr_price: track.curr_price,
    email: track.email,
    delivered: false,
    created_at: new Date(),
    subject: `Price change: ${track.product_name}`,
    body: `Price of "${track.product_name}" is now ${track.curr_price}. Original price was ${track.orig_price}. View product here: ${track.price_url}`
  };
  await sendEmail(email);
}

async function sendTrackInactiveEmail(track) {
  let email = {
    track_id: track.id,
    product_name: track.product_name,
    orig_price: track.orig_price,
    curr_price: null,
    email: track.email,
    delivered: false,
    created_at: new Date(),
    subject: `Possible price change: ${track.product_name}`,
    body: `Price of "${track.product_name}" was not found on product page. Original price was ${track.orig_price}. This could indicate a price change some other product change.`
  };
  await sendEmail(email);
}

async function insertEmail(email) {
  try {
    // Insert email data into the database
    const result = await query(
      `INSERT INTO email_logs (track_id, product_name, orig_price, curr_price, email, delivered, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING id`,
      [
        email.track_id,
        email.product_name,
        email.orig_price,
        email.curr_price,
        email.email,
        email.delivered,
        email.created_at,
      ]
    );

    console.info('[crawler] Email log inserted', {
      emailLogId: result.rows[0].id,
      trackId: email.track_id
    });
  } catch (error) {
    console.error('[crawler] Failed to insert email log', {
      trackId: email.track_id,
      recipient: email.email,
      error
    });
  }
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
    console.info('[crawler] Processing track', {
      runId,
      id: track.id,
      productName: track.product_name,
      currPrice: track.curr_price,
      url: track.price_url
    });

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

    console.info('[crawler] Track processed', {
      runId,
      id: track.id,
      status: itemResult.status,
      durationMs: Date.now() - startedAt
    });
  } catch (error) {
    itemResult = {
      ...itemResult,
      status: 'fetch_failed',
      stage: error && error.details && error.details.stage ? error.details.stage : (track.requires_javascript ? 'render-html' : 'fetch-html'),
      errorMessage: error.message,
      failureLogId: error && error.details ? error.details.failureLogId || null : null
    };

    console.error('[crawler] Track update failed', {
      runId,
      id: track.id,
      productName: track.product_name,
      url: track.price_url,
      durationMs: Date.now() - startedAt,
      error
    });
  }

  itemResult.durationMs = Date.now() - startedAt;
  return itemResult;
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
    durationMs: 0
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

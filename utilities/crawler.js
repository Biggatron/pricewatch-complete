const puppeteer = require('puppeteer');
const fetch = (...args) => import('node-fetch').then(({ default: fetch }) => fetch(...args));
const { JSDOM } = require('jsdom');
const fs = require('fs');
const query = require('../db/db');
const keys = require('../config/keys');
const constants = require('../config/const');
const nodemailer = require('nodemailer');

module.exports = {
  updatePrices,
  extractNumber,
  findAndSavePrices
};

function updatePrices() {
  getAndUpdatePrices();
}

async function getAndUpdatePrices() {
  let html = '';
  const result = await query(
    `SELECT * FROM track WHERE active = true or (last_modified_at >= NOW() - INTERVAL '7 days')`
  );
  for (let i = 0; i < result.rows.length; i++) {
    let track = result.rows[i];
    console.log({ id: track.id,
                  productName: track.product_name,
                  currPrice: track.curr_price,
                  url: track.price_url});  
    if (track.requires_javascript) {
      html = await getRenderedHTML(track.price_url);
    } else {
      html = await getHTML(track.price_url);
    } 
    saveHTMLFile(html, track.price_url);
    findPriceFromDiv(html, track)
  }
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
  let attempts = 0;
  let lastError = null;

  while (attempts < 3) {
    try {
      const randomUserAgent = getRandomUserAgent();
      const settings = {
        headers: {
          'User-Agent': randomUserAgent
        }
      };

      const response = await fetch(url, settings);

      if (!response.ok) {
        console.log(`HTTP request failed using user agent: ${randomUserAgent}`)
        throw new Error(`HTTP error! Status: ${response.status}`);
      }

      const html = await response.text();

      if (!html) {
        throw new Error('Empty HTML content');
      }

      //saveHTMLFile(html, url); // Used for debugging
      return html; // Return the successfully fetched HTML
    } catch (error) {
      attempts++;
      lastError = error;
      console.warn(`Attempt ${attempts} failed: ${error.message}`);
    }
  }

  throw new Error(`Failed to fetch HTML after 3 attempts: ${lastError.message}`);
}

async function getRenderedHTML(url) {
  // Launch a headless browser
  const browser = await puppeteer.launch();
  const page = await browser.newPage();
  
  let attempts = 0;
  let lastError = null;

  while (attempts < 3) {
    try {
      const randomUserAgent = getRandomUserAgent();

      // Set user agent
      await page.setUserAgent(randomUserAgent);

      // Navigate to the page
      await page.goto(url, {
          waitUntil: 'networkidle2', // Wait until all network requests are finished
      });
    
      // Extract the fully rendered HTML
      const html = await page.content();

      if (!html) {
        throw new Error('Empty HTML content');
      }
    
      // Close the browser
      await browser.close();
    
      // saveHTMLFile(html, url); // Used for debugging
      return html;
    } catch (error) {
      attempts++;
      lastError = error;
      console.warn(`Attempt ${attempts} failed: ${error.message}`);
    }
  }

  throw new Error(`Failed to fetch HTML after 3 attempts: ${lastError.message}`);
}

function saveHTMLFile(html, url) {
  const fileName = './HTMLs/' + url.slice(0,40).replace(/[^A-Za-z0-9]/g, '') + '.html';
  fs.writeFile(fileName, html, function(err) {
    if (err) throw err;
    console.log('HTML file saved!');
  });
}

async function findPriceFromDiv(html, track) {
  console.log('Updating price for ' + track.product_name)
  let priceDivBeforeAfter = [];

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
    let searchString = `${priceDivBeforeAfter[0].slice(-constants.crawler.htmlMinMatchSize)}(.*?)<`;
    matches = html.match(searchString);
  }
  if (!matches || !matches[1]) {
    matches = findHTMLSubstringRight(hmtl, priceDivBeforeAfter[1].substring(1, constants.crawler.htmlMinMatchSize));
  }

  // If match is not found or match is over 500 characters long
  if (!matches || !matches[1] || matches[1].length >= 500) { 
    console.log('Match not found - Setting track as inactive');
    setTrackAsInactive(track);
    return;
  } 

  // If numer has more than 20 digits then something went wrong in matching
  let match = extractNumber(matches[1]);
  if (match.length > 20) {
    match = ''; 
  }
  console.log({ 
    match: matches[1],
    cleanMatch: match
  });

  // If tracked price has changed we update database and send email to user
  if (isNumeric(match)) {
    if (match !== track.curr_price) {
      updatePrice(match, track);

      // Update track object with new price before sending email
      track.curr_price = match;
      sendPriceUpdateEmail(track);  
    }
    if (!track.active) {
      setTrackAsActive(track);
    }
  } else {
    console.log('Match found is not a number - Setting track as inactive');
    setTrackAsInactive(track);
    return;
  }
};


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
  sendTrackInactiveEmail(track);
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
    html = await getRenderedHTML(trackRequest.price_url);
  } else {
    html = await getHTML(trackRequest.price_url);
  }
  const dom = new JSDOM(html);
  const document = dom.window.document;
  let title = '';

  // Get product name from title
  try {
    title = document.getElementsByTagName("title")[0].textContent || '';
    console.log('Title: '+ title);
  } catch (err) {
    console.log('No title element found in html');
  }
  // Use the DOM API to extract values from elements
  const elements = Array.from(document.querySelectorAll("*")).map((x) => x.textContent);
  let tracks = [];
  let htmlStringPos = 0;

  console.log('Looking for price: ' + trackRequest.orig_price);
  console.log('Elements to search: ' + elements.length)
  // Loop through elements to find given price
  for (let i=0;i<elements.length;i++) {
    let htmlPrice = elements[i] || ''; 
    let htmlPriceClean = extractNumber(htmlPrice);
    
    // If element value matches price given by user it get tracked
    if (htmlPriceClean === trackRequest.orig_price) {
      
      // If price string is not found in html we try to replace spaces with HTML word breaks 
      let htmlPriceLocation = html.indexOf(htmlPrice, htmlStringPos);
      if (htmlPriceLocation === -1) {
        console.log({ htmlPrice: htmlPrice });
        htmlPrice = htmlPrice.replace(/\s+/g, '&nbsp;');
        htmlPriceLocation = html.indexOf(htmlPrice, htmlStringPos);
      }
      // If price string is not found in html we process next element. 
      if (htmlPriceLocation === -1) {
        console.log({ htmlPriceWithBreak: htmlPrice });
        console.log('Price match found but not location')
        continue; 
      };
      
      // Get html strings around tracked price to keep track of price
      htmlStringPos = htmlPriceLocation; 
      let startPos = htmlPriceLocation - 500;
      let endPos = htmlPriceLocation + htmlPrice.length + 500;
      let priceDiv = html.substring(startPos, endPos);
      let escapedPriceDiv = escapeRegex(priceDiv); 
      let escapedHTMLPrice = escapeRegex(htmlPrice); 
      console.log({
        escapedPriceDiv: escapedPriceDiv,
        htmlPrice: htmlPrice,
        escapedHTMLPrice: escapedHTMLPrice
      })
      escapedPriceDiv = escapedPriceDiv.replace(escapedHTMLPrice, '(.*?)');
      //escapedPriceDiv.replace(htmlPrice, '(.*?)');
      escapedPriceDiv.trim(); // Remove trailing and leading whitespace

      let track = {
        orig_price: htmlPriceClean,
        curr_price: htmlPriceClean,
        requires_javascript: fullyRenderHTML,
        price_url: trackRequest.price_url,
        price_div: escapedPriceDiv,
        product_name: title,
        user_id: trackRequest.user_id,
        email: trackRequest.email,
        active: true,
        created_at: new Date(),
        last_modified_at: new Date()
      }
      tracks.push(track);
      break; // For now only the first price match is tracked
    }
  }
  if (tracks.length === 0) {
    // If price was not found on plain HTML then attempt to find price on fully rendered page
    if (fullyRenderHTML) {
      addFailedTrackLog(trackRequest, title);
      res.status(200).send('Price not found on page'); 
    } else {
      await findAndSavePrices(trackRequest, true, res);
    }
  } else {
    addTracksToDatabase(tracks, res);
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

    console.log('Failed track log inserted with ID:', result.rows[0].id);
  } catch (error) {
    console.error('Error inserting failed track log:', error);
  }
}

function getDomainFromURL(url) {
  let matches = url.match(/^https?\:\/\/([^\/?#]+)(?:[\/?#]|$)/i);
  return matches && matches[1]; // domain will be null if no match is found
}


async function addTracksToDatabase(tracks, res) {
  console.log('Adding ' + tracks.length + ' tracks to database')
  let trackInsertCount = 0;

  // Loop through tracks and add/update database
  for (let i = 0; i < tracks.length; i++) {
    let track = tracks[i];
    console.log(track);

    
    // Check if track exists, if so then update existing.
    let existingTrack = await trackExists(track);
    if (existingTrack) {
      console.log('Updating track' + existingTrack.id);
      const updateResult = await query(
        'UPDATE track SET "curr_price" = $1, "last_modified_at" = $2, "price_div" = $3, "product_name" = $4, "active" = $5, "requires_javascript" = $6 WHERE "id" = $7 RETURNING *',
        [track.curr_price, new Date(), track.price_div, track.product_name, track.active, track.requires_javascript, existingTrack.id]
      );
      console.log({updateResult: updateResult})
      if (updateResult.rows[0] && updateResult.rows[0].id) {
        ++trackInsertCount;
      }
    } else {
      console.log('Inserting track')
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
  console.log(`Getting track with url ${track.price_url } and for user: ${track.user_id}`)
  let existingTrackResult = await query(
    `SELECT * FROM track WHERE user_id = $1 and price_url = $2 ORDER BY created_at DESC`,
    [track.user_id, track.price_url]
  );
  return existingTrackResult.rows[0];
}

async function updatePrice(newPrice, track) {
  console.log(`UpdatePrice: trackId=${track.id} newPrice=${newPrice}`);
  const compResult = await query(
    'UPDATE track SET "curr_price" = $1, "last_modified_at" = $2 WHERE "id" = $3',
    [newPrice, new Date(), track.id]
  );
}

async function sendEmail(email) {
  if (constants.email.sendEmail) {
    try {
      // Create a transporter
      const transporter = nodemailer.createTransport({
        service: keys.email.service,
        auth: {
          user: keys.email.address, 
          pass: keys.email.password,   // App password or your email password
        },
      });

      // Email options
      const mailOptions = {
        from: keys.email.address, // Sender email
        to: email.email,          // Recipient email
        subject: email.subject,   // Email subject
        text: email.body,         // Plain text message
      };

      // Send the email
      const info = await transporter.sendMail(mailOptions);
      
      // Email sent successfully
      email.delivered = true;
      console.log('Email sent: ' + info.response);
    } catch (error) {
      console.error('Error sending email: ', error);
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
  sendEmail(email);
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
  sendEmail(email);
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

    console.log('Email record inserted with ID:', result.rows[0].id);
  } catch (error) {
    console.error('Error inserting email log:', error);
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
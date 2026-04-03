const path = require('path');
const ejs = require('ejs');

const EMAIL_TEMPLATE_DIR = path.join(__dirname, '..', 'views', 'emails');

async function renderEmailTemplate(templateKey, data = {}) {
  const renderer = TEMPLATE_RENDERERS[templateKey];
  if (!renderer) {
    throw new Error(`Unknown email template: ${templateKey}`);
  }

  const viewModel = renderer.buildViewModel(data);
  const contentHtml = await renderTemplateFile(renderer.htmlFile, viewModel);
  const html = await renderTemplateFile('layout.ejs', {
    ...viewModel,
    accentColor: viewModel.accentColor || '#ffb758',
    contentHtml
  });
  const text = await renderTemplateFile(renderer.textFile, viewModel);

  return {
    templateKey,
    subject: viewModel.subject,
    html,
    text
  };
}

const TEMPLATE_RENDERERS = {
  price_change: {
    htmlFile: 'price-change.ejs',
    textFile: 'price-change.txt.ejs',
    buildViewModel(data) {
      const productName = String(data.productName || 'Tracked product').trim();
      const productUrl = String(data.productUrl || '').trim();
      const originalPrice = normalizeNumericValue(data.originalPrice);
      const previousPrice = normalizeNumericValue(data.previousPrice);
      const currentPrice = normalizeNumericValue(data.currentPrice);
      const isDrop = currentPrice != null && previousPrice != null
        ? currentPrice < previousPrice
        : true;
      const changeLabel = isDrop ? 'Price drop' : 'Price increase';
      const headline = isDrop ? 'The price dropped' : 'The price increased';
      const accentColor = isDrop ? '#2f8f5b' : '#c84b43';
      const arrowHtml = isDrop ? '&darr;' : '&uarr;';
      const showOriginalPrice = (
        originalPrice != null &&
        previousPrice != null &&
        originalPrice !== previousPrice
      );
      const currentPriceFormatted = formatPrice(currentPrice, data.currentPrice);
      const previousPriceFormatted = formatPrice(previousPrice, data.previousPrice);
      const originalPriceFormatted = formatPrice(originalPrice, data.originalPrice);
      const directionPhrase = isDrop ? 'dropped' : 'increased';

      return {
        productName,
        productUrl,
        originalPriceFormatted,
        previousPriceFormatted,
        currentPriceFormatted,
        showOriginalPrice,
        isDrop,
        changeLabel,
        headline,
        accentColor,
        arrowHtml,
        subject: `${changeLabel}: ${productName}`,
        previewText: `${productName} ${directionPhrase} from ${previousPriceFormatted} to ${currentPriceFormatted}.`
      };
    }
  },
  track_inactive: {
    htmlFile: 'track-inactive.ejs',
    textFile: 'track-inactive.txt.ejs',
    buildViewModel(data) {
      const productName = String(data.productName || 'Tracked product').trim();
      const productUrl = String(data.productUrl || '').trim();
      const originalPrice = normalizeNumericValue(data.originalPrice);

      return {
        productName,
        productUrl,
        originalPriceFormatted: formatPrice(originalPrice, data.originalPrice),
        accentColor: '#f39c12',
        subject: `Tracking paused: ${productName}`,
        previewText: `We could not locate the price for ${productName}.`,
        possibleReasons: [
          'a price change',
          'the product being discontinued',
          'a change in the webpage layout',
          'a technical error',
          'another unknown reason'
        ]
      };
    }
  }
};

function normalizeNumericValue(value) {
  if (value == null || value === '') {
    return null;
  }

  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function formatPrice(parsedValue, rawValue) {
  if (parsedValue == null) {
    const fallback = String(rawValue == null ? '' : rawValue).trim();
    return fallback || '-';
  }

  return new Intl.NumberFormat('en-US', {
    maximumFractionDigits: 2
  }).format(parsedValue);
}

async function renderTemplateFile(relativeFilePath, data) {
  const filePath = path.join(EMAIL_TEMPLATE_DIR, relativeFilePath);

  return new Promise((resolve, reject) => {
    ejs.renderFile(filePath, data, (error, markup) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(markup);
    });
  });
}

module.exports = {
  renderEmailTemplate,
  TEMPLATE_RENDERERS
};

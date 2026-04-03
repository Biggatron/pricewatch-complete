const GRAPH_WIDTH = 820;
const GRAPH_HEIGHT = 180;
const GRAPH_LEFT = 90;
const GRAPH_RIGHT = 18;
const GRAPH_TOP = 18;
const GRAPH_BOTTOM = 34;

function buildTrackHistoryGraphModel(track, historyEntries = [], now = new Date()) {
  const startDate = toDate(track.created_at) || toDate(track.last_modified_at) || new Date(now);
  const endDateCandidate = toDate(now) || new Date();
  const endDate = endDateCandidate.getTime() >= startDate.getTime()
    ? endDateCandidate
    : new Date(startDate);

  const initialPrice = toFiniteNumber(track.orig_price) ?? toFiniteNumber(track.curr_price) ?? 0;
  const changeEntries = historyEntries
    .map((entry) => ({
      changedAt: toDate(entry.changed_at),
      priceAfter: toFiniteNumber(entry.price_after)
    }))
    .filter((entry) => entry.changedAt && entry.priceAfter != null)
    .sort((left, right) => left.changedAt.getTime() - right.changedAt.getTime());

  const priceEvents = [];
  let currentPrice = initialPrice;

  for (const entry of changeEntries) {
    if (entry.priceAfter === currentPrice) {
      continue;
    }

    priceEvents.push({
      changedAt: entry.changedAt,
      fromPrice: currentPrice,
      toPrice: entry.priceAfter
    });
    currentPrice = entry.priceAfter;
  }

  const observedPrices = [initialPrice, ...priceEvents.flatMap((event) => [event.fromPrice, event.toPrice])];
  const actualMinPrice = Math.min(...observedPrices);
  const actualMaxPrice = Math.max(...observedPrices);
  const pricePadding = actualMinPrice === actualMaxPrice
    ? Math.max(1, Math.abs(actualMinPrice || 1) * 0.05)
    : (actualMaxPrice - actualMinPrice) * 0.12;
  const domainMinPrice = actualMinPrice - pricePadding;
  const domainMaxPrice = actualMaxPrice + pricePadding;

  const chartWidth = GRAPH_WIDTH - GRAPH_LEFT - GRAPH_RIGHT;
  const chartHeight = GRAPH_HEIGHT - GRAPH_TOP - GRAPH_BOTTOM;
  const totalDurationMs = endDate.getTime() - startDate.getTime();

  const xFor = (date) => {
    if (totalDurationMs <= 0) {
      return date.getTime() <= startDate.getTime()
        ? GRAPH_LEFT
        : GRAPH_LEFT + chartWidth;
    }

    const clampedTime = Math.min(Math.max(date.getTime(), startDate.getTime()), endDate.getTime());
    return GRAPH_LEFT + ((clampedTime - startDate.getTime()) / totalDurationMs) * chartWidth;
  };

  const yFor = (price) => {
    if (domainMaxPrice === domainMinPrice) {
      return GRAPH_TOP + chartHeight / 2;
    }

    return GRAPH_TOP + ((domainMaxPrice - price) / (domainMaxPrice - domainMinPrice)) * chartHeight;
  };

  let path = `M ${formatCoordinate(xFor(startDate))} ${formatCoordinate(yFor(initialPrice))}`;
  for (const event of priceEvents) {
    const eventX = formatCoordinate(xFor(event.changedAt));
    path += ` H ${eventX} V ${formatCoordinate(yFor(event.toPrice))}`;
  }
  path += ` H ${formatCoordinate(totalDurationMs <= 0 ? GRAPH_LEFT + chartWidth : xFor(endDate))}`;

  const changeMarkers = priceEvents.map((event) => ({
    x: formatCoordinate(xFor(event.changedAt)),
    fromY: formatCoordinate(yFor(event.fromPrice)),
    toY: formatCoordinate(yFor(event.toPrice))
  }));

  const yAxisLabels = actualMinPrice === actualMaxPrice
    ? [
        {
          y: formatCoordinate(yFor(actualMaxPrice)),
          text: formatPrice(actualMaxPrice)
        }
      ]
    : [
        {
          y: formatCoordinate(yFor(actualMaxPrice)),
          text: formatPrice(actualMaxPrice)
        },
        {
          y: formatCoordinate(yFor(actualMinPrice)),
          text: formatPrice(actualMinPrice)
        }
      ];

  return {
    width: GRAPH_WIDTH,
    height: GRAPH_HEIGHT,
    chartLeft: GRAPH_LEFT,
    chartRight: GRAPH_WIDTH - GRAPH_RIGHT,
    chartTop: GRAPH_TOP,
    chartBottom: GRAPH_HEIGHT - GRAPH_BOTTOM,
    chartHeight,
    baselineY: formatCoordinate(GRAPH_HEIGHT - GRAPH_BOTTOM),
    linePath: path,
    changeMarkers,
    yAxisLabels,
    startLabel: formatDateLabel(startDate),
    endLabel: formatDateLabel(endDate),
    hasPriceChanges: priceEvents.length > 0
  };
}

function toFiniteNumber(value) {
  const numericValue = Number(value);
  return Number.isFinite(numericValue) ? numericValue : null;
}

function toDate(value) {
  if (!value) {
    return null;
  }

  const parsedDate = new Date(value);
  return Number.isFinite(parsedDate.getTime()) ? parsedDate : null;
}

function formatCoordinate(value) {
  return Number(value).toFixed(2);
}

function formatPrice(value) {
  return `${new Intl.NumberFormat('is-IS', { maximumFractionDigits: 0 }).format(Math.round(value))} kr.`;
}

function formatDateLabel(date) {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric'
  }).format(date);
}

module.exports = {
  buildTrackHistoryGraphModel
};

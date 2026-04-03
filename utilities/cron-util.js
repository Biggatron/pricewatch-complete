function isValidCronExpression(expression) {
  try {
    parseCronExpression(expression);
    return true;
  } catch (error) {
    return false;
  }
}

function matchesCronExpression(expression, date = new Date()) {
  const parsed = parseCronExpression(expression);
  const values = [
    date.getMinutes(),
    date.getHours(),
    date.getDate(),
    date.getMonth() + 1,
    date.getDay()
  ];

  return parsed.every((field, index) => matchesCronField(field, values[index]));
}

function getCurrentOrNextCronOccurrence(expression, date = new Date()) {
  const currentMinute = startOfMinute(date);
  if (matchesCronExpression(expression, currentMinute)) {
    return currentMinute;
  }

  return getNextCronOccurrence(expression, currentMinute);
}

function getNextCronOccurrence(expression, fromDate = new Date()) {
  parseCronExpression(expression);

  const candidate = startOfMinute(fromDate);
  candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);

  const maxIterations = 60 * 24 * 366;
  for (let index = 0; index < maxIterations; index += 1) {
    if (matchesCronExpression(expression, candidate)) {
      return new Date(candidate.getTime());
    }

    candidate.setMinutes(candidate.getMinutes() + 1, 0, 0);
  }

  throw new Error('Unable to determine next cron occurrence within one year');
}

function parseCronExpression(expression) {
  const normalizedExpression = String(expression || '').trim().replace(/\s+/g, ' ');
  const parts = normalizedExpression.split(' ');

  if (parts.length !== 5) {
    throw new Error('Cron expression must contain 5 fields');
  }

  return [
    parseCronField(parts[0], 0, 59),
    parseCronField(parts[1], 0, 23),
    parseCronField(parts[2], 1, 31),
    parseCronField(parts[3], 1, 12),
    parseCronField(parts[4], 0, 7, { normalizeDayOfWeek: true })
  ];
}

function parseCronField(fieldExpression, min, max, options = {}) {
  const segments = String(fieldExpression || '').split(',');
  if (segments.length === 0) {
    throw new Error('Cron field is empty');
  }

  return segments.map((segment) => parseCronSegment(segment.trim(), min, max, options));
}

function parseCronSegment(segment, min, max, options = {}) {
  if (!segment) {
    throw new Error('Cron segment is empty');
  }

  const [base, stepValue] = segment.split('/');
  if (segment.split('/').length > 2) {
    throw new Error(`Invalid cron segment: ${segment}`);
  }

  const step = stepValue == null ? 1 : Number.parseInt(stepValue, 10);
  if (!Number.isInteger(step) || step <= 0) {
    throw new Error(`Invalid cron step: ${segment}`);
  }

  if (base === '*') {
    return { start: min, end: max, step };
  }

  if (base.includes('-')) {
    const [startText, endText] = base.split('-');
    let start = parseCronNumber(startText, min, max, options);
    let end = parseCronNumber(endText, min, max, options);

    if (end < start) {
      throw new Error(`Invalid cron range: ${segment}`);
    }

    return { start, end, step };
  }

  const value = parseCronNumber(base, min, max, options);
  return { start: value, end: value, step };
}

function parseCronNumber(rawValue, min, max, options = {}) {
  const parsedValue = Number.parseInt(rawValue, 10);
  if (!Number.isInteger(parsedValue)) {
    throw new Error(`Invalid cron value: ${rawValue}`);
  }

  const normalizedValue = options.normalizeDayOfWeek && parsedValue === 7
    ? 0
    : parsedValue;

  if (normalizedValue < min || normalizedValue > max) {
    throw new Error(`Cron value out of range: ${rawValue}`);
  }

  return normalizedValue;
}

function matchesCronField(field, value) {
  return field.some((segment) => {
    if (value < segment.start || value > segment.end) {
      return false;
    }

    return (value - segment.start) % segment.step === 0;
  });
}

function startOfMinute(date) {
  const normalizedDate = new Date(date);
  normalizedDate.setSeconds(0, 0);
  return normalizedDate;
}

module.exports = {
  isValidCronExpression,
  matchesCronExpression,
  getCurrentOrNextCronOccurrence,
  getNextCronOccurrence,
  startOfMinute
};

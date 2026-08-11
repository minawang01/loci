const fs = require('fs');
const chrono = require('chrono-node');
const { BUSY_PATH, ensureDataDir } = require('./paths');

// Anchored to the first token, like #todo and #done, so "I'm #busy later"
// stays a plain note. Leading tags are allowed for parity with #goals.
const BUSY_TAG = /^\s*(?:#\w+\s+)*#busy\b/i;

// Words whose only job was to introduce the time phrase, and which read as
// noise once the phrase itself has been lifted out of the label.
const CONNECTOR = /^[\s,:–—-]*\b(for|at|on|from|doing|with|to)\b[\s,:]*/i;
const TRAILING_CONNECTOR = /[\s,:–—-]*\b(for|at|on|from|doing|with|to)\s*$/i;

const MINUTES_PER_DAY = 24 * 60;

// The longest block worth believing. The planning window itself is 16h, so a
// block can still swallow a whole day, but a reversed range — "5pm-3pm", which
// chrono resolves by rolling the end onto tomorrow — comes out at 22h and is
// almost always a typo rather than a genuine all-but-two-hours commitment.
const MAX_BLOCK_MINUTES = 16 * 60;

function ensureBusyFile() {
  ensureDataDir();
  if (!fs.existsSync(BUSY_PATH)) fs.writeFileSync(BUSY_PATH, JSON.stringify({}, null, 2));
}

// Day-scoped like #todo: an object keyed by "YYYY-MM-DD", each day holding the
// blocks logged for it, so a new message appends rather than replacing.
function loadBusy() {
  ensureBusyFile();
  const parsed = JSON.parse(fs.readFileSync(BUSY_PATH, 'utf8'));
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
}

function saveBusy(days) {
  fs.writeFileSync(BUSY_PATH, JSON.stringify(days, null, 2));
}

function isBusyText(text) {
  return BUSY_TAG.test(String(text || ''));
}

function newId() {
  return `busy_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function localDate(date) {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function cleanLabel(text) {
  return text
    .replace(CONNECTOR, '')
    .replace(TRAILING_CONNECTOR, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function cut(text, index, length) {
  return `${text.slice(0, index)} ${text.slice(index + length)}`;
}

// chrono reads "noon to 1pm" but not "noon-1pm" — it takes the latter as "noon"
// followed by a stray "-1" and yields 1pm with no end. Spelling the two words
// out as clock times up front keeps both hyphenated and worded ranges working.
function normalizeClockWords(text) {
  return text.replace(/\bnoon\b/gi, '12pm').replace(/\bmidnight\b/gi, '12am');
}

// "for 2 hrs", "8 hours", "90 mins", "an hour", "half an hour".
// chrono reads "for 2 hrs" as a moment two hours in the *past*, not as a length
// attached to the start time, so the duration is lifted out before chrono sees
// the text and applied to the start itself.
const DURATION =
  /(?:\bfor\s+)?\b(?:(\d+(?:[.,]\d+)?)|(half\s+an?|an?))\s*(hours|hour|hrs|hr|h|minutes|minute|mins|min|m)(?![a-z])/i;

function matchDuration(text) {
  const match = DURATION.exec(text);
  if (!match) return null;

  const [phrase, digits, word, unit] = match;
  const count = digits ? Number(digits.replace(',', '.')) : /half/i.test(word) ? 0.5 : 1;
  const perUnit = /^h/i.test(unit) ? 60 : 1;
  const minutes = Math.round(count * perUnit);
  if (!minutes) return null;

  return { minutes, index: match.index, length: phrase.length };
}

function withinLimit(start, end) {
  const minutes = (end - start) / 60000;
  return minutes > 0 && minutes <= MAX_BLOCK_MINUTES;
}

// "9am-5pm work" and "3pm for 2 hrs dentist" both become
// { date, start, end, label }. A range is resolved by chrono in one pass —
// including any day phrase, so "tomorrow 9am-5pm" and a bare "9am-5pm" each
// land on the right day. Failing that, a start time plus a length works out
// to the same thing.
//
// forwardDate is deliberately off: with it on, a bare "7-8pm dinner" logged at
// 8pm would be pushed onto tomorrow, when the sender plainly meant tonight.
function parseBusy(text, reference = new Date()) {
  const rest = normalizeClockWords(String(text || '').replace(BUSY_TAG, '').trim());
  if (!rest) return null;

  const range = chrono.parse(rest, reference).find(r => r.end);
  if (range) {
    const start = range.start.date();
    const end = range.end.date();
    if (!withinLimit(start, end)) return null;
    return {
      id: newId(),
      date: localDate(start),
      start: start.toISOString(),
      end: end.toISOString(),
      label: cleanLabel(cut(rest, range.index, range.text.length))
    };
  }

  // No range: a start time carries a length instead. Without either there is
  // nothing to subtract from the day, so "#busy work" and "#busy 3pm dentist"
  // are skipped rather than stored as a zero-length block.
  const duration = matchDuration(rest);
  if (!duration) return null;

  const withoutDuration = cut(rest, duration.index, duration.length);
  const [at] = chrono.parse(withoutDuration, reference);
  if (!at) return null;

  const start = at.start.date();
  const end = new Date(start.getTime() + duration.minutes * 60000);
  if (!withinLimit(start, end)) return null;

  return {
    id: newId(),
    date: localDate(start),
    start: start.toISOString(),
    end: end.toISOString(),
    label: cleanLabel(cut(withoutDuration, at.index, at.text.length))
  };
}

// Overlaps are stored as sent; they are collapsed only when availability is
// read, so the log stays a faithful record of what was actually said.
function addBlock(text, reference = new Date()) {
  const block = parseBusy(text, reference);
  if (!block) return null;

  const days = loadBusy();
  if (!Array.isArray(days[block.date])) days[block.date] = [];
  days[block.date].push(block);
  saveBusy(days);
  return block;
}

// A block logged by text can only be corrected by deleting it — there is no
// "#unbusy" — so the tab that shows the week can also drop one.
function removeBlock(date, id) {
  const days = loadBusy();
  const blocks = days[date];
  if (!Array.isArray(blocks)) return false;

  const remaining = blocks.filter(block => block.id !== id);
  if (remaining.length === blocks.length) return false;

  if (remaining.length) days[date] = remaining;
  else delete days[date];
  saveBusy(days);
  return true;
}

function blocksFor(date) {
  const blocks = loadBusy()[date];
  return Array.isArray(blocks) ? blocks.slice().sort((a, b) => a.start.localeCompare(b.start)) : [];
}

// A run of consecutive days, empty ones included, so a week view can render
// the calendar rather than only the days that happen to have blocks.
function blocksBetween(from, days) {
  const start = new Date(`${from}T00:00:00`);
  return Array.from({ length: Math.max(0, days) }, (_, offset) => {
    const day = new Date(start.getTime());
    day.setDate(day.getDate() + offset);
    const date = localDate(day);
    return { date, blocks: blocksFor(date) };
  });
}

// "7am", "11pm", "7:30am", "19:00", "noon" -> minutes past midnight.
function parseClock(value) {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'noon') return 12 * 60;
  if (text === 'midnight') return 0;

  const match = /^(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/.exec(text);
  if (!match) return null;

  let hours = Number(match[1]);
  const minutes = Number(match[2] || 0);
  const meridiem = match[3];
  if (minutes > 59) return null;
  if (meridiem) {
    if (hours < 1 || hours > 12) return null;
    hours = (hours % 12) + (meridiem === 'pm' ? 12 : 0);
  } else if (hours > 24) {
    return null;
  }
  return hours * 60 + minutes;
}

function minutesInto(date, iso) {
  const midnight = new Date(`${date}T00:00:00`).getTime();
  return Math.round((Date.parse(iso) - midnight) / 60000);
}

function clockLabel(minutes) {
  const total = ((minutes % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
  const hours = Math.floor(total / 60);
  const mins = String(total % 60).padStart(2, '0');
  const meridiem = hours >= 12 ? 'pm' : 'am';
  return `${((hours + 11) % 12) + 1}:${mins}${meridiem}`;
}

function durationLabel(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (!hours) return `${mins}m`;
  return mins ? `${hours}h ${mins}m` : `${hours}h`;
}

// Collapses overlapping and touching ranges into the smallest equivalent set.
function mergeRanges(ranges) {
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  const merged = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

// The planning window minus the union of that day's busy blocks. Blocks are
// clipped to the window, so an overnight shift or a 6am gym slot only counts
// for the part of it that would otherwise have been plannable.
function availability(date, windowStart, windowEnd) {
  const from = parseClock(windowStart);
  const to = parseClock(windowEnd);
  const start = from === null ? 7 * 60 : from;
  const end = to === null ? 23 * 60 : to;
  const blocks = blocksFor(date);

  const busy = mergeRanges(
    blocks
      .map(block => ({
        start: Math.max(start, minutesInto(date, block.start)),
        end: Math.min(end, minutesInto(date, block.end))
      }))
      .filter(range => range.end > range.start)
  );

  const free = [];
  let cursor = start;
  for (const range of busy) {
    if (range.start > cursor) free.push({ start: cursor, end: range.start });
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < end) free.push({ start: cursor, end });

  const freeMinutes = free.reduce((total, range) => total + (range.end - range.start), 0);

  return {
    blocks,
    windowMinutes: Math.max(0, end - start),
    freeMinutes,
    freeRanges: free.map(range => `${clockLabel(range.start)}–${clockLabel(range.end)}`),
    freeLabel: durationLabel(freeMinutes)
  };
}

function timeRange(block) {
  return `${clockLabel(minutesInto(block.date, block.start))}–${clockLabel(
    minutesInto(block.date, block.end)
  )}`;
}

function describeBlock(block) {
  const time = timeRange(block);
  return block.label ? `${time} ${block.label}` : time;
}

module.exports = {
  BUSY_PATH,
  isBusyText,
  parseBusy,
  addBlock,
  loadBusy,
  blocksFor,
  blocksBetween,
  removeBlock,
  availability,
  timeRange,
  describeBlock,
  parseClock,
  clockLabel,
  durationLabel
};

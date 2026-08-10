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

// "9am-5pm work" -> { date, start, end, label: "work" }. chrono resolves the
// range and any day phrase in one pass, against today as the reference point,
// so "tomorrow 9am-5pm" and a bare "9am-5pm" both land on the right day.
//
// forwardDate is deliberately off: with it on, a bare "7-8pm dinner" logged at
// 8pm would be pushed onto tomorrow, when the sender plainly meant tonight.
function parseBusy(text, reference = new Date()) {
  const rest = String(text || '').replace(BUSY_TAG, '').trim();
  if (!rest) return null;

  // Only a range marks time as unavailable — a lone instant ("3pm dentist")
  // has no duration to subtract, so it is skipped rather than stored as zero.
  const result = chrono.parse(rest, reference).find(r => r.end);
  if (!result) return null;

  const start = result.start.date();
  const end = result.end.date();
  if (!(end > start)) return null;

  const label = (rest.slice(0, result.index) + ' ' + rest.slice(result.index + result.text.length))
    .replace(CONNECTOR, '')
    .replace(TRAILING_CONNECTOR, '')
    .replace(/\s+/g, ' ')
    .trim();

  return {
    id: newId(),
    date: localDate(start),
    start: start.toISOString(),
    end: end.toISOString(),
    label
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

function blocksFor(date) {
  const blocks = loadBusy()[date];
  return Array.isArray(blocks) ? blocks.slice().sort((a, b) => a.start.localeCompare(b.start)) : [];
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
  availability,
  timeRange,
  describeBlock,
  parseClock,
  clockLabel,
  durationLabel
};

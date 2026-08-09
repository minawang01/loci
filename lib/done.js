const notes = require('./notes');

// Words too common to be evidence that two phrases describe the same task.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'and', 'or', 'but', 'if', 'then', 'to', 'of', 'in', 'on',
  'at', 'by', 'for', 'with', 'about', 'from', 'into', 'my', 'me', 'i', 'we',
  'you', 'it', 'its', 'this', 'that', 'these', 'those', 'is', 'am', 'are',
  'was', 'were', 'be', 'been', 'do', 'did', 'done', 'get', 'got', 'go', 'went',
  'up', 'out', 'off', 'over', 'some', 'all', 'today', 'tomorrow', 'yesterday'
]);

// Crude stemming so "emailed" matches "email" and "letters" matches "letter".
// A real stemmer would be overkill for one-line todo items.
function stem(word) {
  return word
    .replace(/(ied)$/, 'y')
    .replace(/(ing|ed)$/, '')
    .replace(/(ies)$/, 'y')
    .replace(/s$/, '');
}

function keywords(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word && !STOPWORDS.has(word))
      .map(stem)
      .filter(word => word.length > 1)
  );
}

function overlap(a, b) {
  let count = 0;
  for (const word of a) if (b.has(word)) count++;
  return count;
}

// Two shared keywords is enough to be confident; one is only enough when one
// side has nothing else to offer ("#done dishes" vs "- [ ] dishes").
function isConfident(score, a, b) {
  if (score >= 2) return true;
  return score === 1 && Math.min(a.size, b.size) === 1;
}

// Body lines of a list entry, paired with the item index setItemDone uses.
// A line without a checkbox still counts — older multi-line "#todo" messages
// landed that way — and reads as not done.
function checkboxItems(entry) {
  const items = [];
  let index = -1;
  for (const line of entry.body.split('\n')) {
    if (!line.trim()) continue;
    const match = /^\s*[-*]\s*\[([ xX])\]\s*(.*)$/.exec(line);
    items.push(
      match
        ? { index: ++index, text: match[2].trim(), done: match[1].toLowerCase() === 'x' }
        : { index: ++index, text: line.replace(/^\s*[-*]\s*/, '').trim(), done: false }
    );
  }
  return items;
}

// Finds the item on today's list that best describes `text`. Undone items win
// ties, so saying the same thing twice doesn't tick a third, weaker match.
function findMatch(text) {
  const entry = notes.dailyTodo();
  if (!entry) return null;

  const needle = keywords(text);
  if (!needle.size) return null;

  let best = null;
  for (const item of checkboxItems(entry)) {
    const score = overlap(needle, keywords(item.text));
    if (!isConfident(score, needle, keywords(item.text))) continue;
    if (!best || score > best.score || (score === best.score && best.item.done && !item.done)) {
      best = { entry, item, score };
    }
  }
  return best;
}

// "#done emailed professor" ticks the matching item off today's list, or —
// when nothing on the list resembles it — records it as an item that was
// already finished, creating the day's list if this is its first entry.
function markDone(text) {
  const item = String(text || '').trim();
  if (!item) return null;

  const match = findMatch(item);
  if (match) {
    notes.setItemDone(match.entry.id, match.item.index, true, match.entry.dateTime);
    return { matched: true, text: match.item.text, list: notes.dailyTodoName() };
  }

  return { matched: false, text: item, list: notes.addToDailyTodo(item, true) };
}

module.exports = { markDone, findMatch, keywords };

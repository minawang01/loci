const chrono = require('chrono-node');
const LocalFileStorageProvider = require('./storage/LocalFileStorageProvider');
const { GOALS_PATH } = require('./paths');

let storageProvider = new LocalFileStorageProvider();

function setStorageProvider(p) {
  storageProvider = p || storageProvider;
}

// Anchored to the first token, like the sibling rules, so "write down my
// #goals someday" stays a plain note instead of being swallowed by rule 1.
// Leading tags are allowed, since "#goals #todo ..." resolves to a goal.
const GOAL_TAG = /^\s*(?:#\w+\s+)*#goals\b/i;

// Words that only exist to introduce the date phrase, and read as noise once
// the date itself has been lifted out of the title.
const TRAILING_CONNECTOR = /[\s,]*\b(by|on|before|until|due(?:\s+by)?|at|in)\s*$/i;

function ensureGoalsFile() {
  storageProvider.ensureDataDir && storageProvider.ensureDataDir();
  const existing = storageProvider.readFileSync ? storageProvider.readFileSync(GOALS_PATH) : null;
  if (existing === null) {
    if (storageProvider.writeFileSync) storageProvider.writeFileSync(GOALS_PATH, JSON.stringify([], null, 2));
    else storageProvider.writeFile(GOALS_PATH, JSON.stringify([], null, 2));
  }
}

function loadGoals() {
  ensureGoalsFile();
  const raw = storageProvider.readFileSync ? storageProvider.readFileSync(GOALS_PATH) : '[]';
  return JSON.parse(raw || '[]');
}

function saveGoals(goals) {
  if (storageProvider.writeFileSync) storageProvider.writeFileSync(GOALS_PATH, JSON.stringify(goals, null, 2));
  else storageProvider.writeFile(GOALS_PATH, JSON.stringify(goals, null, 2));
}

function isGoalText(text) {
  return GOAL_TAG.test(String(text || ''));
}

// Notes are addressed by their position in notes.md, which shifts whenever an
// earlier entry is deleted. Goals are patched by id from the dashboard, so
// they need an identifier that survives the list changing underneath them.
function newId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function tidy(text) {
  return text.replace(TRAILING_CONNECTOR, '').replace(/\s+/g, ' ').trim();
}

// Pulls a date phrase out of the title line only. Subtask lines are ignored so
// "- ask for 2 letters" cannot be read as a time.
//
// "@" marks the deadline explicitly — "#goals ship the essay @friday" — which
// is unambiguous where prose is not: "call mum on Sunday" reads its date out of
// the title whether or not that was meant. Everything after the last "@" is the
// date phrase; if it doesn't parse the whole line falls back to prose parsing,
// so an email address or a handle in a title can't swallow it.
function extractDeadline(titleLine, reference = new Date()) {
  const at = titleLine.lastIndexOf('@');
  if (at !== -1) {
    const [explicit] = chrono.parse(titleLine.slice(at + 1), reference, { forwardDate: true });
    if (explicit) {
      return { title: tidy(titleLine.slice(0, at)), deadline: explicit.date().toISOString() };
    }
  }

  const [result] = chrono.parse(titleLine, reference, { forwardDate: true });
  if (!result) return { title: titleLine.trim(), deadline: null };

  const withoutDate =
    titleLine.slice(0, result.index) + titleLine.slice(result.index + result.text.length);

  return { title: tidy(withoutDate), deadline: result.date().toISOString() };
}

// Words too common to say anything about what a goal is about.
const STOPWORDS = new Set([
  'a', 'an', 'the', 'my', 'to', 'for', 'of', 'and', 'or', 'in', 'on', 'at',
  'with', 'do', 'get', 'make', 'more', 'some', 'this', 'that', 'it'
]);

// Crude singularisation — enough that "tiktoks" and "tiktok" are the same word
// without pulling in a stemming library for one comparison.
function stem(word) {
  if (word.length > 3 && word.endsWith('s') && !word.endsWith('ss')) return word.slice(0, -1);
  return word;
}

function significantWords(title) {
  return new Set(
    String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter(word => word && !STOPWORDS.has(word))
      .map(stem)
  );
}

// Verbs that name an activity rather than a subject. On their own they say
// nothing about *which* goal is meant — "run" fits "run a marathon" and "run
// the shop" equally — so a one-word title made only of these never matches.
const GENERIC_VERBS = new Set([
  'run', 'learn', 'quit', 'book', 'move', 'apply', 'call', 'write', 'read',
  'plan', 'start', 'finish', 'buy', 'work', 'build', 'fix', 'send', 'study',
  'practice', 'train', 'save', 'clean', 'email', 'meet', 'visit'
]);

// Two titles name the same goal when one's meaningful words are entirely
// contained in the other's: "tiktoks" and "tiktok essays" are one goal, while
// "LSAT prep" and "LSAT application" are not — they each carry a word the other
// lacks, so merging them would be a guess.
function sameGoal(a, b) {
  const first = significantWords(a);
  const second = significantWords(b);
  if (!first.size || !second.size) return false;

  const [smaller, larger] = first.size <= second.size ? [first, second] : [second, first];
  if (![...smaller].every(word => larger.has(word))) return false;

  // A single bare verb is not enough to identify a goal.
  return !(smaller.size === 1 && smaller.size < larger.size && GENERIC_VERBS.has([...smaller][0]));
}

// "#goals finish LSAT application by December 1" plus optional "- subtask"
// lines becomes a structured goal. Stray non-bulleted lines stay in the
// description rather than being silently dropped.
function parseGoal(text, reference = new Date()) {
  const original = String(text || '');
  const lines = original.split('\n');
  // Drop the leading tag cluster, so "#goals #todo run a marathon" titles the
  // goal "run a marathon" rather than carrying the losing tag into the text.
  let titleLine = (lines[0] || '')
    .replace(/^(?:\s*#\w+)+/, '')
    .replace(/\s+/g, ' ')
    .trim();

  // A tag on a line of its own: the title is the next chunk of prose, which
  // may be indented under it. Bullets are skipped so a bare "#goals" followed
  // by a checklist doesn't lose its first subtask to the title.
  let titleIndex = 0;
  if (!titleLine) {
    titleIndex = lines.findIndex(
      (line, index) => index > 0 && line.trim() && !/^\s*[-*]\s+/.test(line)
    );
    if (titleIndex === -1) titleIndex = 0;
    else titleLine = lines[titleIndex].replace(/\s+/g, ' ').trim();
  }

  const { title, deadline } = extractDeadline(titleLine, reference);
  const id = newId('goal');

  const subtasks = lines
    .filter((_, index) => index !== titleIndex)
    .map(line => line.trim())
    .filter(line => /^[-*]\s+/.test(line))
    .map(line => ({
      id: newId('sub'),
      text: line.replace(/^[-*]\s+/, '').trim(),
      done: false
    }))
    .filter(subtask => subtask.text);

  return {
    id,
    title,
    deadline,
    subtasks,
    description: original.trim(),
    status: 'active',
    created_at: new Date().toISOString()
  };
}

// Folds a restatement of a goal into the one already stored. Only additive:
// new subtasks are appended, a deadline is filled in when there wasn't one,
// and the more descriptive title wins — "tiktok essays" says more than
// "tiktoks". An existing deadline is left alone, since re-dating a goal from a
// passing mention of it is the kind of edit you want to make deliberately, on
// the Goals tab.
function mergeInto(existing, incoming) {
  const seen = new Set((existing.subtasks || []).map(s => s.text.toLowerCase()));
  const added = incoming.subtasks.filter(s => !seen.has(s.text.toLowerCase()));

  existing.subtasks = [...(existing.subtasks || []), ...added];
  if (incoming.deadline && !existing.deadline) existing.deadline = incoming.deadline;
  // More words, not more characters: a longer restatement of the same words
  // shouldn't rename anything.
  if (significantWords(incoming.title).size > significantWords(existing.title).size) {
    existing.title = incoming.title;
  }
  existing.description = [existing.description, incoming.description].filter(Boolean).join('\n\n');
  return added.length;
}

// Returns { goal, merged, addedSubtasks } rather than the bare goal, because
// the caller has to tell you which of the two things happened.
function createGoal(text) {
  const incoming = parseGoal(text);
  const goals = loadGoals();

  // Only live goals absorb a restatement — mentioning something finished is
  // starting it again, not amending it.
  const matches = goals.filter(goal => goal.status !== 'done' && sameGoal(goal.title, incoming.title));

  // Word-for-word the same goal, which no other candidate can claim more
  // strongly — so it wins even in a crowd, and sending the same text twice
  // amends rather than piling up duplicates.
  const wanted = [...significantWords(incoming.title)].sort().join(' ');
  const exact = matches.filter(
    goal => [...significantWords(goal.title)].sort().join(' ') === wanted
  );

  // Otherwise two equally good candidates leave no way to tell which was meant:
  // picking one by array order would silently fold a goal into the wrong place,
  // so this becomes its own goal and the caller says which ones it resembles.
  const only = exact.length === 1 ? exact[0] : matches.length === 1 ? matches[0] : null;
  if (only) {
    const addedSubtasks = mergeInto(only, incoming);
    saveGoals(goals);
    return { goal: only, merged: true, addedSubtasks };
  }

  goals.push(incoming);
  saveGoals(goals);
  return {
    goal: incoming,
    merged: false,
    addedSubtasks: incoming.subtasks.length,
    ambiguous: matches.map(match => match.title)
  };
}

function findGoal(goals, id) {
  return goals.find(goal => goal.id === id) || null;
}

// Flips a goal between "active" and "done", or sets it outright when the
// caller knows which state it wants.
function setStatus(id, status) {
  const goals = loadGoals();
  const goal = findGoal(goals, id);
  if (!goal) return null;
  goal.status = status || (goal.status === 'done' ? 'active' : 'done');
  saveGoals(goals);
  return goal;
}

// Title and deadline only: subtasks are ticked through their own endpoint, and
// status through setStatus.
function updateGoal(id, { title, deadline } = {}) {
  const goals = loadGoals();
  const goal = findGoal(goals, id);
  if (!goal) return null;

  if (typeof title === 'string') goal.title = title.replace(/\s+/g, ' ').trim();
  // null clears the deadline; undefined leaves it alone.
  if (deadline !== undefined) goal.deadline = deadline;
  saveGoals(goals);
  return goal;
}

function deleteGoal(id) {
  const goals = loadGoals();
  const remaining = goals.filter(goal => goal.id !== id);
  if (remaining.length === goals.length) return false;
  saveGoals(remaining);
  return true;
}

function setSubtaskDone(goalId, subtaskId, done) {
  const goals = loadGoals();
  const goal = findGoal(goals, goalId);
  if (!goal) return null;
  const subtask = (goal.subtasks || []).find(s => s.id === subtaskId);
  if (!subtask) return null;
  subtask.done = typeof done === 'boolean' ? done : !subtask.done;
  saveGoals(goals);
  return goal;
}

module.exports = {
  GOALS_PATH,
  isGoalText,
  parseGoal,
  createGoal,
  loadGoals,
  saveGoals,
  sameGoal,
  updateGoal,
  deleteGoal,
  setStatus,
  setSubtaskDone
};

module.exports.setStorageProvider = setStorageProvider;

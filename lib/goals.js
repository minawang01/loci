const fs = require('fs');
const chrono = require('chrono-node');
const { GOALS_PATH, ensureDataDir } = require('./paths');

// Anchored to the first token, like the sibling rules, so "write down my
// #goals someday" stays a plain note instead of being swallowed by rule 1.
// Leading tags are allowed, since "#goals #todo ..." resolves to a goal.
const GOAL_TAG = /^\s*(?:#\w+\s+)*#goals\b/i;

// Words that only exist to introduce the date phrase, and read as noise once
// the date itself has been lifted out of the title.
const TRAILING_CONNECTOR = /[\s,]*\b(by|on|before|until|due(?:\s+by)?|at|in)\s*$/i;

function ensureGoalsFile() {
  ensureDataDir();
  if (!fs.existsSync(GOALS_PATH)) {
    fs.writeFileSync(GOALS_PATH, JSON.stringify([], null, 2));
  }
}

function loadGoals() {
  ensureGoalsFile();
  return JSON.parse(fs.readFileSync(GOALS_PATH, 'utf8'));
}

function saveGoals(goals) {
  fs.writeFileSync(GOALS_PATH, JSON.stringify(goals, null, 2));
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

// Pulls a date phrase out of the title line only. Subtask lines are ignored so
// "- ask for 2 letters" cannot be read as a time.
function extractDeadline(titleLine, reference = new Date()) {
  const [result] = chrono.parse(titleLine, reference, { forwardDate: true });
  if (!result) return { title: titleLine.trim(), deadline: null };

  const withoutDate =
    titleLine.slice(0, result.index) + titleLine.slice(result.index + result.text.length);

  return {
    title: withoutDate.replace(TRAILING_CONNECTOR, '').replace(/\s+/g, ' ').trim(),
    deadline: result.date().toISOString()
  };
}

// "#goals finish LSAT application by December 1" plus optional "- subtask"
// lines becomes a structured goal. Stray non-bulleted lines stay in the
// description rather than being silently dropped.
function parseGoal(text, reference = new Date()) {
  const original = String(text || '');
  const lines = original.split('\n');
  // Drop the leading tag cluster, so "#goals #todo run a marathon" titles the
  // goal "run a marathon" rather than carrying the losing tag into the text.
  const titleLine = (lines[0] || '')
    .replace(/^(?:\s*#\w+)+/, '')
    .replace(/\s+/g, ' ')
    .trim();
  const { title, deadline } = extractDeadline(titleLine, reference);
  const id = newId('goal');

  const subtasks = lines
    .slice(1)
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

function createGoal(text) {
  const goal = parseGoal(text);
  const goals = loadGoals();
  goals.push(goal);
  saveGoals(goals);
  return goal;
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
  setStatus,
  setSubtaskDone
};

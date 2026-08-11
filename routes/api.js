const express = require('express');
const notes = require('../lib/notes');
const tags = require('../lib/tags');
const goals = require('../lib/goals');
const done = require('../lib/done');
const busy = require('../lib/busy');
const plan = require('../lib/plan');
const sms = require('../lib/sms');

const router = express.Router();

// -- Notes --
router.get('/notes', (req, res) => {
  const { q, tag } = req.query;
  let result = notes.parseEntries().reverse(); // newest first
  if (q) result = notes.searchNotes(q).reverse();
  if (tag) result = notes.notesByTag(tag).reverse();
  res.json(result);
});

router.post('/notes', (req, res) => {
  const { text, tags: manualTags = [] } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

  // Same tag rules the SMS webhook applies, in the same order, so both entry
  // points agree on what a message means.
  const trimmed = text.trim();
  if (goals.isGoalText(trimmed)) {
    const { goal, merged } = goals.createGoal(trimmed);
    return res.status(201).json({ ok: true, goal, merged });
  }

  if (busy.isBusyText(trimmed)) {
    const block = busy.addBlock(trimmed);
    if (!block) return res.status(400).json({ error: 'give me a time range, like "9am-5pm"' });
    return res.status(201).json({ ok: true, busy: block });
  }

  if (/^#todo\b/i.test(trimmed)) {
    const items = notes.todoItems(trimmed.replace(/^#todo\b/i, ''));
    if (!items.length) return res.status(400).json({ error: 'todo item is required' });
    notes.addToDailyTodo(items);
    return res.status(201).json({ ok: true, list: notes.dailyTodoName() });
  }

  if (/^#done\b/i.test(trimmed)) {
    const result = done.markDone(trimmed.replace(/^#done\b/i, ''));
    if (!result) return res.status(400).json({ error: 'tell me what you finished' });
    return res.status(201).json({ ok: true, ...result });
  }

  const detected = Array.from(new Set([...tags.detectTags(text), ...manualTags]));
  notes.appendNote(text.trim(), detected);
  res.status(201).json({ ok: true, tags: detected });
});

router.delete('/notes/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: 'invalid note id' });
  const deleted = notes.deleteEntry(id, req.query.dateTime);
  if (!deleted) return res.status(404).json({ error: 'note not found' });
  res.json({ ok: true });
});

// Ticking a checkbox off a list. `itemIndex` counts checkbox lines within the
// entry, matching the order the dashboard renders them.
router.patch('/notes/:id/items/:itemIndex', (req, res) => {
  const id = Number(req.params.id);
  const itemIndex = Number(req.params.itemIndex);
  const { done } = req.body || {};
  if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: 'invalid note id' });
  if (!Number.isInteger(itemIndex) || itemIndex < 0) {
    return res.status(400).json({ error: 'invalid item index' });
  }
  if (done !== undefined && typeof done !== 'boolean') {
    return res.status(400).json({ error: 'done must be a boolean' });
  }

  const updated = notes.setItemDone(id, itemIndex, done, req.query.dateTime);
  if (!updated) return res.status(404).json({ error: 'item not found' });
  res.json({ ok: true });
});

router.get('/todos/today', (req, res) => {
  res.json({ name: notes.dailyTodoName(), entry: notes.dailyTodo() });
});

router.post('/lists', (req, res) => {
  const { name, items = [], tags: manualTags = [] } = req.body;
  if (!name) return res.status(400).json({ error: 'name is required' });
  notes.createList(name, items, manualTags.length ? manualTags : [name]);
  res.status(201).json({ ok: true });
});

router.post('/lists/:tag/items', (req, res) => {
  const { item } = req.body;
  if (!item) return res.status(400).json({ error: 'item is required' });
  const added = notes.addItemToList(req.params.tag, item);
  if (!added) return res.status(404).json({ error: `no existing list found for "${req.params.tag}"` });
  res.status(201).json({ ok: true });
});

// -- Goals --
router.get('/goals', (req, res) => res.json(goals.loadGoals()));

router.post('/goals', (req, res) => {
  const { text } = req.body;
  if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
  const { goal, merged } = goals.createGoal(text.trim());
  res.status(201).json({ ...goal, merged });
});

// One endpoint for three edits, since the dashboard sends whichever the user
// touched: a bare `{}` still flips status, preserving the original behaviour.
router.patch('/goals/:id', (req, res) => {
  const { status, title, deadline } = req.body || {};
  if (status && status !== 'active' && status !== 'done') {
    return res.status(400).json({ error: 'status must be "active" or "done"' });
  }
  if (title !== undefined && (typeof title !== 'string' || !title.trim())) {
    return res.status(400).json({ error: 'title must be a non-empty string' });
  }
  if (deadline !== undefined && deadline !== null && Number.isNaN(Date.parse(deadline))) {
    return res.status(400).json({ error: 'deadline must be a date or null' });
  }

  const edited = title !== undefined || deadline !== undefined;
  const goal = edited
    ? goals.updateGoal(req.params.id, { title, deadline })
    : goals.setStatus(req.params.id, status);
  if (!goal) return res.status(404).json({ error: 'goal not found' });

  // A status sent alongside an edit still applies.
  res.json(edited && status ? goals.setStatus(req.params.id, status) : goal);
});

router.delete('/goals/:id', (req, res) => {
  if (!goals.deleteGoal(req.params.id)) return res.status(404).json({ error: 'goal not found' });
  res.json({ ok: true });
});

router.patch('/goals/:id/subtasks/:subtaskId', (req, res) => {
  const { done } = req.body || {};
  if (done !== undefined && typeof done !== 'boolean') {
    return res.status(400).json({ error: 'done must be a boolean' });
  }
  const goal = goals.setSubtaskDone(req.params.id, req.params.subtaskId, done);
  if (!goal) return res.status(404).json({ error: 'goal or subtask not found' });
  res.json(goal);
});

// -- Busy blocks --
// A run of days rather than the whole store, so the Busy tab can show the week
// ahead. Empty days are included: a day with nothing on it is information.
const MAX_BUSY_DAYS = 60;

router.get('/busy', (req, res) => {
  const from = req.query.from || req.query.date || notes.today();
  const days = req.query.days === undefined ? 1 : Number(req.query.days);

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from)) {
    return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
  }
  if (!Number.isInteger(days) || days < 1 || days > MAX_BUSY_DAYS) {
    return res.status(400).json({ error: `days must be 1-${MAX_BUSY_DAYS}` });
  }

  const withTimes = day => ({
    ...day,
    blocks: day.blocks.map(block => ({ ...block, time: busy.timeRange(block) }))
  });
  const range = busy.blocksBetween(from, days).map(withTimes);

  // The single-day shape predates the week view and is what the one-day
  // callers still read.
  res.json({ from, days: range, ...range[0] });
});

router.delete('/busy/:date/:id', (req, res) => {
  if (!busy.removeBlock(req.params.date, req.params.id)) {
    return res.status(404).json({ error: 'block not found' });
  }
  res.json({ ok: true });
});

// -- Plan --
// The same generation the nightly job runs, on demand. Texting it is opt-in per
// request: the dashboard shows the plan on screen, which works even while
// outbound SMS is carrier-blocked.
router.post('/plan', async (req, res) => {
  // Any future day can be planned, not just tomorrow; omitting the date keeps
  // the nightly job's meaning.
  const { date } = req.body || {};
  if (date !== undefined) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    }
    if (date < notes.today()) {
      return res.status(400).json({ error: 'that day has already been and gone' });
    }
  }

  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY is not configured' });
  }

  let generated;
  try {
    generated = await plan.generatePlan(new Date(), date);
  } catch (err) {
    console.error('Plan generation failed:', err.message);
    return res.status(502).json({ error: 'Could not generate a plan. Try again shortly.' });
  }

  const body = { ...generated, sent: false };
  if (req.body && req.body.send && sms.canSend(process.env.PLAN_PHONE_NUMBER)) {
    try {
      await sms.sendMessage(process.env.PLAN_PHONE_NUMBER, generated.message);
      body.sent = true;
    } catch (err) {
      // The plan itself succeeded, so it is still returned — only delivery failed.
      console.error('Plan send failed:', err.message);
      body.sendError = err.message;
    }
  }
  res.json(body);
});

// -- Tags --
router.get('/tags', (req, res) => res.json(tags.loadTags()));

router.post('/tags', (req, res) => {
  try {
    const created = tags.addTag(req.body);
    res.status(201).json(created);
  } catch (e) {
    res.status(400).json({ error: e.message });
  }
});

router.patch('/tags/:name', (req, res) => {
  try {
    const updated = tags.updateTag(req.params.name, req.body);
    res.json(updated);
  } catch (e) {
    res.status(404).json({ error: e.message });
  }
});

module.exports = router;

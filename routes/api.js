const express = require('express');

function createApiRouter(stores, { plan, sms }) {
  const { notes, tags, goals, busy, done } = stores;
  const router = express.Router();

  // -- Notes --
  router.get('/notes', async (req, res) => {
    const { q, tag } = req.query;
    let result = (await notes.parseEntries()).reverse(); // newest first
    if (q) result = (await notes.searchNotes(q)).reverse();
    if (tag) result = (await notes.notesByTag(tag)).reverse();
    res.json(result);
  });

  router.post('/notes', async (req, res) => {
    const { text, tags: manualTags = [] } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });

    // Same tag rules the SMS webhook applies, in the same order, so both entry
    // points agree on what a message means.
    const trimmed = text.trim();
    if (goals.isGoalText(trimmed)) {
      const { goal, merged, ambiguous } = await goals.createGoal(trimmed);
      return res.status(201).json({ ok: true, goal, merged, ambiguous });
    }

    if (busy.isBusyText(trimmed)) {
      const block = await busy.addBlock(trimmed);
      if (!block) return res.status(400).json({ error: 'give me a time range, like "9am-5pm"' });
      return res.status(201).json({ ok: true, busy: block });
    }

    if (/^#todo\b/i.test(trimmed)) {
      const items = notes.todoItems(trimmed.replace(/^#todo\b/i, ''));
      if (!items.length) return res.status(400).json({ error: 'todo item is required' });
      await notes.addToDailyTodo(items);
      return res.status(201).json({ ok: true, list: notes.dailyTodoName() });
    }

    if (/^#done\b/i.test(trimmed)) {
      const result = await done.markDone(trimmed.replace(/^#done\b/i, ''));
      if (!result) return res.status(400).json({ error: 'tell me what you finished' });
      return res.status(201).json({ ok: true, ...result });
    }

    const detected = Array.from(new Set([...(await tags.detectTags(text)), ...manualTags]));
    await notes.appendNote(text.trim(), detected);
    res.status(201).json({ ok: true, tags: detected });
  });

  router.delete('/notes/:id', async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: 'invalid note id' });
    const deleted = await notes.deleteEntry(id, req.query.dateTime);
    if (!deleted) return res.status(404).json({ error: 'note not found' });
    res.json({ ok: true });
  });

  // Ticking a checkbox off a list. `itemIndex` counts checkbox lines within the
  // entry, matching the order the dashboard renders them.
  router.patch('/notes/:id/items/:itemIndex', async (req, res) => {
    const id = Number(req.params.id);
    const itemIndex = Number(req.params.itemIndex);
    const { done: isDone } = req.body || {};
    if (!Number.isInteger(id) || id < 0) return res.status(400).json({ error: 'invalid note id' });
    if (!Number.isInteger(itemIndex) || itemIndex < 0) {
      return res.status(400).json({ error: 'invalid item index' });
    }
    if (isDone !== undefined && typeof isDone !== 'boolean') {
      return res.status(400).json({ error: 'done must be a boolean' });
    }

    const updated = await notes.setItemDone(id, itemIndex, isDone, req.query.dateTime);
    if (!updated) return res.status(404).json({ error: 'item not found' });
    res.json({ ok: true });
  });

  router.get('/todos/today', async (req, res) => {
    res.json({ name: notes.dailyTodoName(), entry: await notes.dailyTodo() });
  });

  router.post('/lists', async (req, res) => {
    const { name, items = [], tags: manualTags = [] } = req.body;
    if (!name) return res.status(400).json({ error: 'name is required' });
    await notes.createList(name, items, manualTags.length ? manualTags : [name]);
    res.status(201).json({ ok: true });
  });

  router.post('/lists/:tag/items', async (req, res) => {
    const { item } = req.body;
    if (!item) return res.status(400).json({ error: 'item is required' });
    const added = await notes.addItemToList(req.params.tag, item);
    if (!added) return res.status(404).json({ error: `no existing list found for "${req.params.tag}"` });
    res.status(201).json({ ok: true });
  });

  // -- Goals --
  router.get('/goals', async (req, res) => res.json(await goals.loadGoals()));

  router.post('/goals', async (req, res) => {
    const { text } = req.body;
    if (!text || !text.trim()) return res.status(400).json({ error: 'text is required' });
    const { goal, merged, ambiguous } = await goals.createGoal(text.trim());
    res.status(201).json({ ...goal, merged, ambiguous });
  });

  // One endpoint for three edits, since the dashboard sends whichever the user
  // touched: a bare `{}` still flips status, preserving the original behaviour.
  router.patch('/goals/:id', async (req, res) => {
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
      ? await goals.updateGoal(req.params.id, { title, deadline })
      : await goals.setStatus(req.params.id, status);
    if (!goal) return res.status(404).json({ error: 'goal not found' });

    // A status sent alongside an edit still applies.
    res.json(edited && status ? await goals.setStatus(req.params.id, status) : goal);
  });

  router.delete('/goals/:id', async (req, res) => {
    if (!(await goals.deleteGoal(req.params.id))) return res.status(404).json({ error: 'goal not found' });
    res.json({ ok: true });
  });

  router.patch('/goals/:id/subtasks/:subtaskId', async (req, res) => {
    const { done: isDone } = req.body || {};
    if (isDone !== undefined && typeof isDone !== 'boolean') {
      return res.status(400).json({ error: 'done must be a boolean' });
    }
    const goal = await goals.setSubtaskDone(req.params.id, req.params.subtaskId, isDone);
    if (!goal) return res.status(404).json({ error: 'goal or subtask not found' });
    res.json(goal);
  });

  // -- Busy blocks --
  // A run of days rather than the whole store, so the Busy tab can show the week
  // ahead. Empty days are included: a day with nothing on it is information.
  const MAX_BUSY_DAYS = 60;

  router.get('/busy', async (req, res) => {
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
    const range = (await busy.blocksBetween(from, days)).map(withTimes);

    // The single-day shape predates the week view and is what the one-day
    // callers still read.
    res.json({ from, days: range, ...range[0] });
  });

  router.delete('/busy/:date/:id', async (req, res) => {
    if (!(await busy.removeBlock(req.params.date, req.params.id))) {
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
  router.get('/tags', async (req, res) => res.json(await tags.loadTags()));

  router.post('/tags', async (req, res) => {
    try {
      const created = await tags.addTag(req.body);
      res.status(201).json(created);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  router.patch('/tags/:name', async (req, res) => {
    try {
      const updated = await tags.updateTag(req.params.name, req.body);
      res.json(updated);
    } catch (e) {
      res.status(404).json({ error: e.message });
    }
  });

  return router;
}

module.exports = createApiRouter;

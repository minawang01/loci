const express = require('express');
const notes = require('../lib/notes');
const tags = require('../lib/tags');

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
  const detected = Array.from(new Set([...tags.detectTags(text), ...manualTags]));
  notes.appendNote(text.trim(), detected);
  res.status(201).json({ ok: true, tags: detected });
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

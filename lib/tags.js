const fs = require('fs');
const path = require('path');

const TAGS_PATH = path.join(__dirname, '..', 'data', 'tags.json');

function ensureTagsFile() {
  if (!fs.existsSync(TAGS_PATH)) {
    fs.writeFileSync(TAGS_PATH, JSON.stringify([], null, 2));
  }
}

function loadTags() {
  ensureTagsFile();
  return JSON.parse(fs.readFileSync(TAGS_PATH, 'utf8'));
}

function saveTags(tags) {
  fs.writeFileSync(TAGS_PATH, JSON.stringify(tags, null, 2));
}

// tag: { name, color, keywords: [...], parent: null | parentName }
function addTag({ name, color = '#888888', keywords = [], parent = null }) {
  const tags = loadTags();
  if (tags.find(t => t.name.toLowerCase() === name.toLowerCase())) {
    throw new Error(`Tag "${name}" already exists`);
  }
  tags.push({ name, color, keywords: keywords.map(k => k.toLowerCase()), parent });
  saveTags(tags);
  return tags;
}

function updateTag(name, updates) {
  const tags = loadTags();
  const tag = tags.find(t => t.name.toLowerCase() === name.toLowerCase());
  if (!tag) throw new Error(`Tag "${name}" not found`);
  Object.assign(tag, updates);
  saveTags(tags);
  return tag;
}

// Given raw text, find explicit #hashtags AND keyword-matched tags.
// Returns a de-duped array of tag names.
function detectTags(text) {
  const tags = loadTags();
  const lower = text.toLowerCase();
  const matched = new Set();

  // explicit hashtags, e.g. "#grocery" or "#create"
  const hashtagMatches = text.match(/#(\w+)/g) || [];
  hashtagMatches.forEach(h => {
    const name = h.slice(1);
    const known = tags.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (known) matched.add(known.name);
    else matched.add(name); // allow ad-hoc tags not pre-registered
  });

  // keyword matching
  tags.forEach(tag => {
    (tag.keywords || []).forEach(kw => {
      if (kw && lower.includes(kw)) matched.add(tag.name);
    });
  });

  return Array.from(matched);
}

module.exports = { loadTags, saveTags, addTag, updateTag, detectTags };

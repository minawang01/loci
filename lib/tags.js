const { TAGS_PATH } = require('./paths');

function createTagsStore(storageProvider, tagsPath = TAGS_PATH) {
  async function ensureTagsFile() {
    if (storageProvider.ensureDataDir) await storageProvider.ensureDataDir();
    const existing = await storageProvider.readFile(tagsPath);
    if (existing === null) await storageProvider.writeFile(tagsPath, JSON.stringify([], null, 2));
  }

  async function loadTags() {
    await ensureTagsFile();
    const raw = await storageProvider.readFile(tagsPath);
    return JSON.parse(raw || '[]');
  }

  async function saveTags(tags) {
    await storageProvider.writeFile(tagsPath, JSON.stringify(tags, null, 2));
  }

  // tag: { name, color, keywords: [...], parent: null | parentName }
  async function addTag({ name, color = '#888888', keywords = [], parent = null }) {
    const tags = await loadTags();
    if (tags.find(t => t.name.toLowerCase() === name.toLowerCase())) {
      throw new Error(`Tag "${name}" already exists`);
    }
    tags.push({ name, color, keywords: keywords.map(k => k.toLowerCase()), parent });
    await saveTags(tags);
    return tags;
  }

  async function updateTag(name, updates) {
    const tags = await loadTags();
    const tag = tags.find(t => t.name.toLowerCase() === name.toLowerCase());
    if (!tag) throw new Error(`Tag "${name}" not found`);
    Object.assign(tag, updates);
    await saveTags(tags);
    return tag;
  }

  // Given raw text, find explicit #hashtags AND keyword-matched tags.
  // Returns a de-duped array of tag names.
  async function detectTags(text) {
    const tags = await loadTags();
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

  return { loadTags, saveTags, addTag, updateTag, detectTags };
}

module.exports = createTagsStore;

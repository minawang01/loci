const fs = require('fs');
const path = require('path');

// DATA_DIR lets the notes file and tag registry live on a mounted volume in
// production while defaulting to ./data for local development.
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
const NOTES_PATH = process.env.NOTES_FILE || path.join(DATA_DIR, 'notes.md');
const TAGS_PATH = process.env.TAGS_FILE || path.join(DATA_DIR, 'tags.json');

function ensureDataDir() {
  fs.mkdirSync(path.dirname(NOTES_PATH), { recursive: true });
  fs.mkdirSync(path.dirname(TAGS_PATH), { recursive: true });
}

module.exports = { DATA_DIR, NOTES_PATH, TAGS_PATH, ensureDataDir };

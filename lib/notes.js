const fs = require('fs');
const { NOTES_PATH, ensureDataDir } = require('./paths');

function ensureNotesFile() {
  ensureDataDir();
  if (!fs.existsSync(NOTES_PATH)) {
    fs.writeFileSync(NOTES_PATH, '# Loci Notes\n\n');
  }
}

function timestamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// Splits the file into raw "## ..." blocks, each keeping its trailing "\n---"
// marker, so blocks can be edited or dropped and rejoined byte for byte.
function splitRawBlocks(raw) {
  const titleLineMatch = raw.match(/^#[^#].*\n/);
  const titleLine = titleLineMatch ? titleLineMatch[0] : '';
  const blocks = raw.slice(titleLine.length).split(/(?=\n## )/).filter(b => b.trim());
  return { titleLine, blocks };
}

function today() {
  return timestamp().slice(0, 10); // YYYY-MM-DD
}

// One todo list per calendar day, named by date so a message sent after
// midnight starts a new list instead of extending yesterday's.
function dailyTodoName(date = today()) {
  return `Todo ${date}`;
}

function readRaw() {
  ensureNotesFile();
  return fs.readFileSync(NOTES_PATH, 'utf8');
}

function writeRaw(content) {
  fs.writeFileSync(NOTES_PATH, content);
}

// Splits the file into entry blocks. Entries always start with "## ", so we
// split on that marker directly rather than on the "---" separator — this
// avoids swallowing the first entry into the file's title header.
function parseEntries() {
  const raw = readRaw();
  const withoutTitle = raw.replace(/^#[^#].*\n/, ''); // drop "# Loci Notes" line
  const blocks = withoutTitle
    .split(/\n(?=## )/)
    .map(b => b.replace(/\n?---\s*$/, '').trim())
    .filter(Boolean);
  return blocks
    .filter(b => b.startsWith('##'))
    .map((block, id) => {
      const lines = block.split('\n');
      const header = lines[0].replace(/^##\s*/, '');
      const [dateTime, ...titleParts] = header.split(' — ');
      const title = titleParts.join(' — ') || 'Note';
      const tagLine = lines.find(l => l.startsWith('Tags:'));
      const tags = tagLine
        ? tagLine.replace('Tags:', '').split(',').map(t => t.trim()).filter(Boolean)
        : [];
      const bodyStart = lines.findIndex(l => l.startsWith('Tags:')) + 1;
      const body = lines.slice(bodyStart > 0 ? bodyStart : 1).join('\n').trim();
      // Position in the file. Appends only ever go on the end, so an id stays
      // valid until an entry before it is deleted.
      return { id, dateTime, title, tags, body, raw: block };
    });
}

function appendEntry(title, tags, body) {
  ensureNotesFile();
  const entry = [
    `## ${timestamp()} — ${title}`,
    tags.length ? `Tags: ${tags.join(', ')}` : '',
    '',
    body,
    '',
    '---',
    ''
  ].filter((l, i) => !(l === '' && i === 1 && tags.length === 0)) // tidy blank line if no tags
   .join('\n');

  fs.appendFileSync(NOTES_PATH, '\n' + entry + '\n');
}

function appendNote(text, tags) {
  appendEntry('Note', tags, text);
}

function createList(listName, items, tags) {
  const body = items.map(i => `- [ ] ${i}`).join('\n');
  appendEntry(`List: ${listName}`, tags, body);
}

// Adds an item to the most recent existing list entry matching a tag or title.
// Returns true if a matching list was found and updated, false otherwise —
// callers should fall back to treating the message as a plain tagged note
// when no list exists yet (lists are only created explicitly via "#create list").
function addItemToList(tagOrName, item) {
  const needle = tagOrName.toLowerCase();
  const { titleLine, blocks: rawBlocks } = splitRawBlocks(readRaw());

  for (let i = rawBlocks.length - 1; i >= 0; i--) {
    const block = rawBlocks[i];
    const isList = /—\s*List:/i.test(block);
    const matchesTag = /tags:/i.test(block) && block.toLowerCase().includes(needle);
    const matchesTitle = block.toLowerCase().includes(`list: ${needle}`);
    if (isList && (matchesTag || matchesTitle)) {
      const sepIndex = block.lastIndexOf('\n---');
      rawBlocks[i] =
        sepIndex === -1
          ? block.replace(/\s*$/, '') + `\n- [ ] ${item}\n`
          // Insert straight after the last item rather than before the blank
          // line that precedes "---", so items stay contiguous in the file.
          : block.slice(0, sepIndex).replace(/\s*$/, '') +
            `\n- [ ] ${item}\n\n` +
            block.slice(sepIndex + 1);
      writeRaw(titleLine + rawBlocks.join(''));
      return true;
    }
  }
  return false; // no existing list matched — caller decides what to do
}

// Appends to today's todo list, creating it on the first item of the day.
function addToDailyTodo(item) {
  const name = dailyTodoName();
  if (!addItemToList(name, item)) createList(name, [item], ['todo']);
  return name;
}

// Removes an entry by its parseEntries id. `expectedDateTime` guards against
// deleting the wrong entry if the file shifted between listing and deleting.
function deleteEntry(id, expectedDateTime) {
  const { titleLine, blocks } = splitRawBlocks(readRaw());
  const entryPositions = blocks
    .map((block, index) => (block.trim().startsWith('##') ? index : -1))
    .filter(index => index !== -1);

  const position = entryPositions[id];
  if (position === undefined) return false;
  if (expectedDateTime && !blocks[position].includes(expectedDateTime)) return false;

  blocks.splice(position, 1);
  writeRaw(titleLine + blocks.join(''));
  return true;
}

function dailyTodo() {
  const name = dailyTodoName().toLowerCase();
  return parseEntries().find(e => e.title.toLowerCase() === `list: ${name}`) || null;
}

function searchNotes(query) {
  const q = query.toLowerCase();
  return parseEntries().filter(
    e => e.body.toLowerCase().includes(q) || e.tags.some(t => t.toLowerCase().includes(q)) || e.title.toLowerCase().includes(q)
  );
}

function notesByTag(tag) {
  const t = tag.toLowerCase();
  return parseEntries().filter(e => e.tags.some(x => x.toLowerCase() === t));
}

module.exports = {
  NOTES_PATH,
  appendNote,
  createList,
  addItemToList,
  addToDailyTodo,
  deleteEntry,
  dailyTodo,
  dailyTodoName,
  parseEntries,
  searchNotes,
  notesByTag,
  readRaw
};

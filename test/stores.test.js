const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const LocalFileStorageProvider = require('../lib/storage/LocalFileStorageProvider');
const createNotesStore = require('../lib/notes');
const createTagsStore = require('../lib/tags');
const createGoalsStore = require('../lib/goals');
const createBusyStore = require('../lib/busy');
const createDoneStore = require('../lib/done');

// Mirrors lib/stores.js's buildStores(), but with each store pointed at an
// explicit path under a fresh tmp dir. LocalFileStorageProvider writes to
// exactly the path it's given rather than scoping into its own baseDir, and
// notes.js/tags.js/goals.js/busy.js default to the app's fixed NOTES_PATH/
// etc. constants — so tests must pass distinct paths to stay isolated from
// each other and from the real DATA_DIR. In production this never matters:
// the owner is the only LocalFileStorageProvider user (one instance), and
// GoogleDriveProvider isolates every other account by its own Drive folder
// regardless of the path's basename.
function freshStores() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loci-stores-test-'));
  const provider = new LocalFileStorageProvider(tmpDir);
  const notes = createNotesStore(provider, path.join(tmpDir, 'notes.md'));
  return {
    notes,
    tags: createTagsStore(provider, path.join(tmpDir, 'tags.json')),
    goals: createGoalsStore(provider, path.join(tmpDir, 'goals.json')),
    busy: createBusyStore(provider, path.join(tmpDir, 'busy.json')),
    done: createDoneStore(notes)
  };
}

describe('async store factories', function() {
  it('notes: appends and reads entries against an injected provider', async function() {
    const { notes } = freshStores();

    await notes.appendNote('bought milk', ['grocery']);
    const entries = await notes.parseEntries();

    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].body, 'bought milk');
    assert.deepStrictEqual(entries[0].tags, ['grocery']);
  });

  it('notes: two store instances on different providers do not share state', async function() {
    const a = freshStores();
    const b = freshStores();

    await a.notes.appendNote('only in a', []);
    const aEntries = await a.notes.parseEntries();
    const bEntries = await b.notes.parseEntries();

    assert.strictEqual(aEntries.length, 1);
    assert.strictEqual(bEntries.length, 0);
  });

  it('tags: adds a tag and detects it in text', async function() {
    const { tags } = freshStores();

    await tags.addTag({ name: 'work', keywords: ['standup'] });
    const detected = await tags.detectTags('daily standup at 9am');

    assert.deepStrictEqual(detected, ['work']);
  });

  it('goals: creates a goal and merges a restatement', async function() {
    const { goals } = freshStores();

    const first = await goals.createGoal('#goals finish LSAT application by december 1');
    assert.strictEqual(first.merged, false);

    const second = await goals.createGoal('#goals finish LSAT application\n- ask for 2 letters');
    assert.strictEqual(second.merged, true);
    assert.strictEqual(second.addedSubtasks, 1);

    const all = await goals.loadGoals();
    assert.strictEqual(all.length, 1);
    assert.strictEqual(all[0].subtasks.length, 1);
  });

  it('busy: adds a block and reports availability', async function() {
    const { busy } = freshStores();

    const block = await busy.addBlock('#busy 9am-5pm work');
    assert.ok(block);

    const availability = await busy.availability(block.date, '7am', '11pm');
    assert.ok(availability.freeMinutes < 16 * 60);
  });

  it('done: ticks a matching todo item off the shared notes store', async function() {
    const { notes, done } = freshStores();

    await notes.addToDailyTodo('email professor');
    const result = await done.markDone('emailed professor');

    assert.strictEqual(result.matched, true);
    const today = await notes.dailyTodo();
    assert.ok(today.body.includes('[x] email professor'));
  });
});

const createNotesStore = require('./notes');
const createTagsStore = require('./tags');
const createGoalsStore = require('./goals');
const createBusyStore = require('./busy');
const createDoneStore = require('./done');

function buildStores(storageProvider) {
  const notes = createNotesStore(storageProvider);
  return {
    notes,
    tags: createTagsStore(storageProvider),
    goals: createGoalsStore(storageProvider),
    busy: createBusyStore(storageProvider),
    done: createDoneStore(notes)
  };
}

module.exports = { buildStores };

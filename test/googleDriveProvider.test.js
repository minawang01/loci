const assert = require('assert');
const GoogleDriveProvider = require('../lib/storage/GoogleDriveProvider');

// A minimal in-memory fake drive client implementing the bits used by
// GoogleDriveProvider so tests can verify logic without network calls.
function createFakeDrive() {
  const files = new Map();
  return {
    files: {
      list: async ({ q }) => {
        // ignore q parsing; return all files
        const arr = Array.from(files.values()).map(f => ({ id: f.id, name: f.name }));
        return { data: { files: arr } };
      },
      get: async ({ fileId }, opts) => {
        const f = Array.from(files.values()).find(x => x.id === fileId);
        if (!f) throw new Error('not found');
        return { data: f.content };
      },
      create: async ({ requestBody, media }) => {
        const id = `f_${Math.random().toString(36).slice(2,8)}`;
        const name = requestBody && requestBody.name ? requestBody.name : media && media.name;
        files.set(id, { id, name, content: media && media.body ? media.body : '' });
        return { data: { id } };
      },
      update: async ({ fileId, media }) => {
        const f = Array.from(files.values()).find(x => x.id === fileId);
        if (!f) throw new Error('not found');
        f.content = media && media.body ? media.body : f.content;
        return { data: {} };
      },
      delete: async ({ fileId }) => {
        const key = Array.from(files.keys()).find(k => files.get(k).id === fileId);
        if (key) files.delete(key);
        return { data: {} };
      }
    }
  };
}

describe('GoogleDriveProvider (mocked drive)', function() {
  it('write/read/list/delete roundtrip', async function() {
    const fakeDrive = createFakeDrive();
    const provider = new GoogleDriveProvider({ drive: fakeDrive, folderId: 'root' });

    await provider.writeFile('notes.md', 'hello world');
    const content = await provider.readFile('notes.md');
    assert.strictEqual(content, 'hello world');

    const list = await provider.listFiles('notes');
    assert.ok(list.includes('notes.md'));

    await provider.deleteFile('notes.md');
    const after = await provider.readFile('notes.md');
    assert.strictEqual(after, null);
  });
});

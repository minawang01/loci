const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const LocalFileStorageProvider = require('../lib/storage/LocalFileStorageProvider');

describe('LocalFileStorageProvider', function() {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'loci-test-'));
  const notesPath = path.join(tmpDir, 'notes.md');
  const tagsPath = path.join(tmpDir, 'tags.json');
  const provider = new LocalFileStorageProvider(tmpDir);

  it('ensureDataDir creates base dir', function() {
    // remove if exists
    if (fs.existsSync(tmpDir)) fs.rmSync(tmpDir, { recursive: true });
    provider.ensureDataDir();
    assert.ok(fs.existsSync(tmpDir));
  });

  it('writeFile and readFile roundtrip', function() {
    provider.writeFileSync(notesPath, 'hello');
    const raw = provider.readFileSync(notesPath);
    assert.strictEqual(raw, 'hello');
  });

  it('listFiles returns files', function() {
    provider.writeFileSync(tagsPath, '[]');
    const files = provider.listFilesSync(tagsPath);
    assert.ok(files.some(f => f.endsWith('tags.json')));
  });

  it('deleteFile removes file', function() {
    provider.writeFileSync(path.join(tmpDir, 'todel.txt'), 'x');
    provider.deleteFileSync(path.join(tmpDir, 'todel.txt'));
    assert.ok(!fs.existsSync(path.join(tmpDir, 'todel.txt')));
  });
});

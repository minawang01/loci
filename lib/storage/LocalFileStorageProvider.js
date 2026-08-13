const fs = require('fs');
const path = require('path');
const { DATA_DIR } = require('../paths');

class LocalFileStorageProvider {
  constructor(baseDir) {
    this.baseDir = baseDir || DATA_DIR;
  }

  async ensureDataDir() {
    fs.mkdirSync(this.baseDir, { recursive: true });
  }

  async readFile(p) {
    const full = path.resolve(p);
    try {
      return fs.readFileSync(full, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      throw e;
    }
  }

  readFileSync(p) {
    const full = path.resolve(p);
    try {
      return fs.readFileSync(full, 'utf8');
    } catch (e) {
      if (e && e.code === 'ENOENT') return null;
      throw e;
    }
  }

  async writeFile(p, content) {
    const full = path.resolve(p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  writeFileSync(p, content) {
    const full = path.resolve(p);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }

  async listFiles(prefix) {
    // Return filenames under the prefix directory (non-recursive)
    const dir = path.dirname(prefix);
    try {
      const files = fs.readdirSync(dir);
      // Prepend dir to filenames to match callers expecting full paths
      return files.map(f => path.join(dir, f));
    } catch (e) {
      if (e && e.code === 'ENOENT') return [];
      throw e;
    }
  }

  listFilesSync(prefix) {
    const dir = path.dirname(prefix);
    try {
      const files = fs.readdirSync(dir);
      return files.map(f => path.join(dir, f));
    } catch (e) {
      if (e && e.code === 'ENOENT') return [];
      throw e;
    }
  }

  async deleteFile(p) {
    const full = path.resolve(p);
    try {
      fs.unlinkSync(full);
    } catch (e) {
      if (e && e.code === 'ENOENT') return;
      throw e;
    }
  }

  deleteFileSync(p) {
    const full = path.resolve(p);
    try {
      fs.unlinkSync(full);
    } catch (e) {
      if (e && e.code === 'ENOENT') return;
      throw e;
    }
  }
}

module.exports = LocalFileStorageProvider;

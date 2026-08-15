const path = require('path');
const { google } = require('googleapis');

class GoogleDriveProvider {
  constructor({ drive, oauth2Client, clientId, clientSecret, refreshToken, folderId = null, folderName = 'Loci' } = {}) {
    this.folderId = folderId || null;
    this.folderName = folderName;

    if (drive) {
      this.drive = drive;
      this.oauth2Client = oauth2Client || null;
    } else if (oauth2Client) {
      this.oauth2Client = oauth2Client;
      this.drive = google.drive({ version: 'v3', auth: oauth2Client });
    } else if (clientId && clientSecret) {
      this.oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
      if (refreshToken) this.oauth2Client.setCredentials({ refresh_token: refreshToken });
      this.drive = google.drive({ version: 'v3', auth: this.oauth2Client });
    } else {
      this.drive = null;
      this.oauth2Client = null;
    }
  }

  async ensureDataDir() {
    if (!this.drive) throw new Error('Google API client not configured');
    if (this.folderId) return this.folderId;
    // Try to find an existing folder with the configured name in root
    const res = await this.drive.files.list({
      q: `name = '${this.folderName.replace("'", "\\'")}' and mimeType = 'application/vnd.google-apps.folder' and trashed = false and 'root' in parents`,
      fields: 'files(id,name)'
    });
    if (res.data.files && res.data.files.length) {
      this.folderId = res.data.files[0].id;
      return this.folderId;
    }
    const created = await this.drive.files.create({ requestBody: { name: this.folderName, mimeType: 'application/vnd.google-apps.folder' }, fields: 'id' });
    this.folderId = created.data.id;
    return this.folderId;
  }

  async _ensureFolder() {
    if (!this.folderId) await this.ensureDataDir();
    return this.folderId;
  }

  async _findFileByName(name) {
    const folderId = await this._ensureFolder();
    const q = `'${folderId}' in parents and name = '${name.replace("'", "\\'")}' and trashed = false`;
    const res = await this.drive.files.list({ q, fields: 'files(id,name)' });
    return (res.data.files && res.data.files[0]) || null;
  }

  async readFile(p) {
    if (!this.drive) throw new Error('Google API client not configured');
    const name = path.basename(p);
    const file = await this._findFileByName(name);
    if (!file) return null;
    const resp = await this.drive.files.get({ fileId: file.id, alt: 'media' }, { responseType: 'stream' });
    // Some test/mocked drives may return the content directly as `resp.data`.
    if (typeof resp.data === 'string' || Buffer.isBuffer(resp.data)) return resp.data.toString ? resp.data.toString('utf8') : String(resp.data);
    return await new Promise((resolve, reject) => {
      const chunks = [];
      resp.data.on('data', c => chunks.push(c));
      resp.data.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      resp.data.on('error', reject);
    });
  }

  async writeFile(p, content) {
    if (!this.drive) throw new Error('Google API client not configured');
    const name = path.basename(p);
    const file = await this._findFileByName(name);
    const folderId = await this._ensureFolder();
    // googleapis only accepts a string or a readable stream here: it pipes
    // anything else, so a Buffer threw `part.body.pipe is not a function` and
    // every write to Drive failed.
    const media = { mimeType: 'text/plain', body: String(content) };
    if (file) {
      await this.drive.files.update({ fileId: file.id, media, fields: 'id' });
    } else {
      await this.drive.files.create({ requestBody: { name, parents: [folderId] }, media, fields: 'id' });
    }
  }

  async listFiles(prefix) {
    if (!this.drive) throw new Error('Google API client not configured');
    const folderId = await this._ensureFolder();
    const res = await this.drive.files.list({ q: `'${folderId}' in parents and trashed = false`, fields: 'files(id,name)' });
    return (res.data.files || []).map(f => f.name);
  }

  async deleteFile(p) {
    if (!this.drive) throw new Error('Google API client not configured');
    const name = path.basename(p);
    const file = await this._findFileByName(name);
    if (!file) return;
    await this.drive.files.delete({ fileId: file.id });
  }
}

module.exports = GoogleDriveProvider;

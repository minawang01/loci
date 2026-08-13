// Abstract StorageProvider interface (duck-typed)
// Implementations should provide the async methods used by the app.

/**
 * @typedef {Object} StorageProvider
 * @property {(path: string) => Promise<string|null>} readFile
 * @property {(path: string, content: string) => Promise<void>} writeFile
 * @property {(prefix: string) => Promise<string[]>} listFiles
 * @property {(path: string) => Promise<void>} deleteFile
 * @property {() => Promise<void>} ensureDataDir
 */

module.exports = {};

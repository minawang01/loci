// Resolving a Drive folder is a list-then-create, so two requests that both
// find nothing each create their own folder and later reads land in whichever
// one they happen to pick. The dashboard opens with five concurrent /api calls,
// which is exactly that race, so callers for the same account share a single
// resolution and the id is persisted for every request after it.
const inFlight = new Map();

function ensureAccountFolder(accountRepo, account, provider) {
  if (account.provider_folder_id) return Promise.resolve(account.provider_folder_id);
  if (!provider || typeof provider.ensureDataDir !== 'function') return Promise.resolve(null);

  const key = String(account.id);
  const existing = inFlight.get(key);
  if (existing) return existing;

  const resolving = provider
    .ensureDataDir()
    .then(folderId => {
      if (folderId) accountRepo.updateAccount(account.id, { provider_folder_id: folderId });
      return folderId;
    })
    .finally(() => inFlight.delete(key));

  inFlight.set(key, resolving);
  return resolving;
}

module.exports = { ensureAccountFolder };

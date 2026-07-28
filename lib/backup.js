const { execFile } = require('child_process');
const { DATA_DIR } = require('./paths');

const DEFAULT_INTERVAL_MINUTES = 15;

function runBackup() {
  return new Promise(resolve => {
    const remote = process.env.BACKUP_REMOTE;
    // `copy` never deletes on the remote, so a bad local state cannot destroy
    // the backup.
    execFile('rclone', ['copy', DATA_DIR, remote, '--no-traverse'], (error, stdout, stderr) => {
      if (error) {
        console.error(`Backup to ${remote} failed: ${stderr.trim() || error.message}`);
        return resolve(false);
      }
      console.log(`Backed up ${DATA_DIR} to ${remote}`);
      resolve(true);
    });
  });
}

// Mirrors the data directory to an rclone remote on an interval. Disabled
// unless BACKUP_REMOTE is set, so local development is unaffected.
function startBackups() {
  const remote = process.env.BACKUP_REMOTE;
  if (!remote) return null;

  const minutes = Number(process.env.BACKUP_INTERVAL_MINUTES || DEFAULT_INTERVAL_MINUTES);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    console.error(`Ignoring invalid BACKUP_INTERVAL_MINUTES: ${process.env.BACKUP_INTERVAL_MINUTES}`);
    return null;
  }

  runBackup();
  const timer = setInterval(runBackup, minutes * 60 * 1000);
  timer.unref();
  console.log(`Backing up ${DATA_DIR} to ${remote} every ${minutes} minute(s)`);
  return timer;
}

module.exports = { startBackups, runBackup };

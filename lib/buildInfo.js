const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// Shows which commit is actually running — see Settings/login screen and the
// Dockerfile's build stage, which writes this file after reading .git (then
// deletes .git itself, so it never ships in the final image). Cached after
// the first read since it never changes for the life of the process.
let cached = null;

function getBuildCommit() {
  if (cached) return cached;
  try {
    cached = fs.readFileSync(path.join(__dirname, '..', '.build-commit'), 'utf8').trim();
    return cached;
  } catch (e) {}
  // Local dev (not Docker): .git is right there in the working tree, so ask
  // git directly instead of requiring the file to exist.
  try {
    cached = execSync('git rev-parse --short HEAD', {
      cwd: path.join(__dirname, '..'),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString().trim();
    return cached;
  } catch (e) {}
  cached = 'unknown';
  return cached;
}

module.exports = { getBuildCommit };

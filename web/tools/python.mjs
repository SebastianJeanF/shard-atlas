import {execFileSync} from 'node:child_process';

export function runPython(arguments_, options = {}) {
  const candidates = process.env.SHARD_ATLAS_PYTHON ? [process.env.SHARD_ATLAS_PYTHON] : process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python'];
  for (const command of candidates) {
    try { return execFileSync(command, arguments_, options); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  throw new Error('Install Python 3.10 or later, or set SHARD_ATLAS_PYTHON to its executable.');
}

import {execFileSync} from 'node:child_process';
import {readdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {runPython} from './python.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
runPython([path.join(root, 'tools/build_web.py')], {cwd: root, stdio: 'inherit'});
const files = ['tests', 'web/tests'].flatMap(folder => readdirSync(path.join(root, folder)).filter(name => name.endsWith('.mjs')).sort().map(name => path.join(root, folder, name)));
execFileSync(process.execPath, ['--test', ...files], {cwd: root, stdio: 'inherit'});

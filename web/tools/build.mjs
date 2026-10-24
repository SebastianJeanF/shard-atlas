import {fileURLToPath} from 'node:url';
import {runPython} from './python.mjs';

runPython([fileURLToPath(new URL('../../tools/build_web.py', import.meta.url)), ...process.argv.slice(2)], {stdio: 'inherit'});

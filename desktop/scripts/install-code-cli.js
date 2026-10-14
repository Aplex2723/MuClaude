#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { parseArgs } = require('node:util');
const { installCli } = require('../src/code/install');
const { addToPath } = require('../src/code/path');
try {
  const { values } = parseArgs({ options: { 'bin-dir': { type: 'string' }, replace: { type: 'boolean' }, 'add-to-path': { type: 'boolean' } } });
  const result = installCli({ binDir: values['bin-dir'] ? path.resolve(values['bin-dir']) : undefined, replace: values.replace });
  console.log(`Installed ${result.command}`);
  if (result.backup) console.log(`Previous command saved at ${result.backup}`);
  if (values['add-to-path']) {
    const onPath = addToPath({ binDir: path.dirname(result.command) });
    console.log(`${onPath.changed ? 'Added' : 'Already had'} the PATH lines in ${onPath.file}. Open a new terminal, then run: muclaude code x`);
  } else console.log('Put this directory first on PATH (or re-run with --add-to-path), then run: muclaude code x');
} catch (error) { console.error(error.message); process.exitCode = 1; }

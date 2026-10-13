#!/usr/bin/env node
'use strict';
const path = require('node:path');
const { parseArgs } = require('node:util');
const { installCli } = require('../src/code/install');
try {
  const { values } = parseArgs({ options: { 'bin-dir': { type: 'string' }, replace: { type: 'boolean' } } });
  const result = installCli({ binDir: values['bin-dir'] ? path.resolve(values['bin-dir']) : undefined, replace: values.replace });
  console.log(`Installed ${result.command}`);
  if (result.backup) console.log(`Previous command saved at ${result.backup}`);
  console.log('Put this directory first on PATH, then run: muclaude code x');
} catch (error) { console.error(error.message); process.exitCode = 1; }

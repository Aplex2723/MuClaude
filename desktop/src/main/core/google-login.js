'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const LSREGISTER = '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

function createGoogleLogin({ helperApp, stateDir, run = promisify(execFile), spawn: start = spawn }) {
  let current = { status: 'idle', active: false };
  let session = null;
  const status = () => ({ ...current });
  async function begin(inst, source) {
    if (session) return { ok: false, message: 'Finish or cancel the current Google sign-in first.' };
    if (typeof inst.profileDir !== 'string' || !path.isAbsolute(inst.profileDir)) return { ok: false, message: 'Invalid instance paths.' };
    const s = {}; session = s;
    s.closed = new Promise((resolve) => { s.close = resolve; });
    current = { name: inst.name, active: true, status: 'starting' };
    try {
      const claudeApp = typeof source === 'function' ? await source(() => !!s.cancelRequested) : source;
      const cancelled = () => {
        current = { name: inst.name, active: false, status: 'cancelled' }; session = null; s.close();
        return { ok: false, ...status() };
      };
      if (s.cancelRequested) return cancelled();
      if (typeof claudeApp !== 'string' || !path.isAbsolute(claudeApp)) throw new Error('INVALID_PATH');
      // Register the native helper, not Electron's development executable.
      await run(LSREGISTER, ['-f', helperApp], { timeout: 15000 });
      if (s.cancelRequested) return cancelled();
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      s.config = path.join(stateDir, `google-${randomUUID()}.json`);
      fs.writeFileSync(s.config, JSON.stringify({ profileDir: inst.profileDir, claudeApp, expiresAt: Date.now() + 15 * 60 * 1000 }), { mode: 0o600 });
      s.child = start(path.join(helperApp, 'Contents/MacOS/login-router'), ['--route', s.config], { stdio: ['ignore', 'pipe', 'pipe'] });
      let pending = '';
      let ready;
      const result = new Promise((resolve) => { ready = resolve; });
      const finish = () => {
        if (session !== s) return;
        if (['starting', 'ready'].includes(current.status)) current = { ...current, status: s.cancelRequested ? 'cancelled' : 'error', message: s.cancelRequested ? undefined : 'Google sign-in routing stopped. Please try again.' };
        current.active = false; session = null;
        fs.rmSync(s.config, { force: true });
        ready({ ok: false, ...status() }); s.close();
      };
      s.child.stdout.on('data', (data) => {
        if (session !== s) return;
        pending += data.toString();
        if (pending.length > 8192) { pending = ''; return; }
        let at;
        while ((at = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, at); pending = pending.slice(at + 1);
          let event; try { event = JSON.parse(line); } catch (_) { continue; }
          if (!['ready', 'forwarded', 'cancelled', 'expired', 'error'].includes(event.status)) continue;
          current = { ...current, status: event.status, message: typeof event.message === 'string' ? event.message.slice(0, 500) : undefined };
          if (event.status === 'ready') ready({ ok: true, ...status() });
        }
      });
      // Native stderr can contain OS diagnostics. Never pass it to the renderer.
      s.child.stderr.on('data', () => {});
      s.child.once('error', finish); s.child.once('close', finish);
      return await result;
    } catch (error) {
      if (s.config) fs.rmSync(s.config, { force: true });
      const message = error.message === 'CLAUDE_NOT_FOUND' ? 'Claude Desktop was not found.'
        : error.message === 'INSTANCE_OPEN_FAILED' ? 'Could not open this instance. Apply its settings and try again.'
        : 'Could not start Google sign-in routing. Run npm run build:login-router and try again.';
      session = null; current = { name: inst.name, active: false, status: s.cancelRequested ? 'cancelled' : 'error', message: s.cancelRequested ? undefined : message };
      s.close();
      return { ok: false, ...status() };
    }
  }
  async function cancel() {
    const s = session;
    if (!s) return status();
    s.cancelRequested = true;
    if (s.child) s.child.kill('SIGTERM');
    await s.closed;
    return status();
  }
  return { begin, cancel, status };
}

module.exports = { createGoogleLogin };

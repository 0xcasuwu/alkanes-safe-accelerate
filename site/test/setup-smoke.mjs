// site/test/setup-smoke.mjs — the setup guide (docs/index.html), tested the way a reader follows it.
//
//   node site/test/setup-smoke.mjs [path-to-subfrost-app-checkout]                       (docs/ served locally)
//   BASE_URL=https://0xcasuwu.github.io/alkanes-safe-accelerate/ RUN_COMMAND=1 node site/test/setup-smoke.mjs
//
// Checks: the page loads with no errors and its CSP; the command block is ONE line that clones this repo into
// ~/alkanes-safe-accelerate only when absent and runs its accelerate.sh; the Copy button puts exactly that line
// on the clipboard; the published accelerate.sh is this repo's, byte for byte; the checker link loads.
// RUN_COMMAND=1 then takes the command AS COPIED from the page and runs it in zsh with HOME set to an empty temp
// folder with no GitHub sign-in, so it really downloads the public repo. First the red case (a different folder of
// that name must be left untouched, with the error the guide's troubleshooting names), then a clean run: it waits for
// the server, loads the page it serves and checks its build stamp equals the guide's; then runs the same command
// again and checks it reuses the copy. The server's process group is stopped by its exact PID; the temp folder is deleted.
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../..');
const app = path.resolve(process.argv[2] ?? path.join(os.homedir(), 'Documents/wt-accel-app'));
const require = createRequire(path.join(app, 'package.json'));
const { chromium } = require('@playwright/test');

const results = [];
const record = (name, pass, detail = '') => { results.push({ name, pass }); console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`); };
const port = 4800 + Math.floor(Math.random() * 400);
const server = process.env.BASE_URL ? null : spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1', '--directory', path.join(repo, 'docs')], { stdio: 'ignore' });
const base = process.env.BASE_URL ?? `http://127.0.0.1:${port}/`;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'accel-setup-'));

// Run `cmd` in zsh with HOME=tmp/home; resolve when the server is up (or the shell exits).
function runCommand(cmd, home, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawn('/bin/zsh', ['-f', '-c', cmd], { cwd: home, env: { PATH: process.env.PATH, HOME: home, ACCEL_NO_OPEN: '1', GIT_TERMINAL_PROMPT: '0', TERM: 'dumb', ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    let done = false;
    const finish = (code) => { if (!done) { done = true; clearTimeout(t); resolve({ child, out, code, port: Number(out.match(/running at http:\/\/localhost:(\d+)\//)?.[1]) || null }); } };
    const t = setTimeout(() => finish('timeout'), 180_000);
    const on = (d) => { out += d; if (/files verified/.test(out)) finish(null); };
    child.stdout.on('data', on);
    child.stderr.on('data', on);
    child.on('exit', (c) => finish(c));
  });
}
const stop = (r) => { try { process.kill(-r.child.pid, 'SIGTERM'); } catch {} };

const browser = await chromium.launch();
try {
  await new Promise((r) => setTimeout(r, 700));
  const ctx = await browser.newContext();
  await ctx.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: new URL(base).origin });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.goto(base);
  record('title', (await page.title()) === 'Alkanes-safe Accelerate', await page.title());
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content');
  record('CSP: own scripts only', !!csp && /script-src 'self';/.test(csp));

  const cmd = (await page.textContent('#cmd')).trim();
  const shape = /^\[ -d ~\/alkanes-safe-accelerate \] \|\| git clone https:\/\/github\.com\/0xcasuwu\/alkanes-safe-accelerate\.git ~\/alkanes-safe-accelerate && bash ~\/alkanes-safe-accelerate\/accelerate\.sh$/;
  record('the command is one line: clone only if absent, then run accelerate.sh', !cmd.includes('\n') && shape.test(cmd), cmd);
  await page.click('button[data-copy="cmd"]');
  const clip = await page.evaluate(() => navigator.clipboard.readText());
  record('Copy puts exactly that line on the clipboard', clip === cmd && (await page.textContent('button[data-copy="cmd"]')) === 'Copied');

  const sh = await page.request.get(new URL('accelerate.sh', base).href);
  const shBytes = Buffer.from(await sh.body());
  record('published accelerate.sh is this repo\'s, byte for byte', sh.ok() && shBytes.equals(fs.readFileSync(path.join(repo, 'accelerate.sh'))), `${shBytes.length} bytes`);
  const chk = await page.request.get(new URL('check/', base).href);
  record('the read-only checker link loads', chk.ok() && (await chk.text()).includes('<title>Accelerate Check</title>'));
  const stampMatch = (await page.textContent('footer')).match(/subfrost-app ([0-9a-f]{12})/);
  const guideStamp = stampMatch?.[1];
  record('no page errors', errors.length === 0, errors.slice(0, 2).join(' | ') || 'none');

  if (process.env.RUN_COMMAND === '1') {
    // Red case first: a different folder already named alkanes-safe-accelerate. The command must not touch it,
    // nothing may start, and the guide's troubleshooting must name the error the reader sees.
    const occupied = path.join(tmp, 'occupied');
    fs.mkdirSync(path.join(occupied, 'alkanes-safe-accelerate'), { recursive: true });
    fs.writeFileSync(path.join(occupied, 'alkanes-safe-accelerate/mine.txt'), 'mine');
    const blocked = await runCommand(clip, occupied);
    const guideText = await page.textContent('body');
    record('a different folder of that name → untouched, nothing starts, guide names the error', blocked.port === null && /No such file or directory/.test(blocked.out) && fs.readdirSync(path.join(occupied, 'alkanes-safe-accelerate')).join() === 'mine.txt' && /No such file or directory/.test(guideText), blocked.out.trim().split('\n').pop()?.trim());

    // A fresh home folder with no GitHub sign-in at all: the public repo must download and start.
    const home = path.join(tmp, 'home');
    fs.mkdirSync(home);
    const first = await runCommand(clip, home);
    const firstLines = first.out.trim().split('\n').map((l) => l.trim()).filter(Boolean);
    let served = null;
    if (first.port) {
      const p = await ctx.newPage();
      await p.goto(`http://localhost:${first.port}/`);
      served = await p.textContent('footer');
      await p.close();
    }
    record('the copied command downloads and starts the accelerator', first.port !== null && fs.existsSync(path.join(home, 'alkanes-safe-accelerate/.git')) && /Cloning into/.test(first.out), firstLines.slice(0, 3).join(' | '));
    record('the page it serves is the build the guide names', !!guideStamp && !!served && served.includes(guideStamp), `guide ${guideStamp}`);
    stop(first);
    await new Promise((r) => setTimeout(r, 500));
    const again = await runCommand(clip, home);
    record('the same command again reuses the copy', again.port !== null && !/Cloning into/.test(again.out) && /Up to date/.test(again.out), again.out.trim().split('\n')[0]?.trim());
    stop(again);
  }
} finally {
  await browser.close();
  server?.kill();
  fs.rmSync(tmp, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);

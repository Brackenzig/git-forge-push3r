// Bench harness for git-forge bots (my own script, written fresh).
// Usage: node bench.mjs <main.ts path> [--fake-env] [--n <requests>] [--issues <count>]
// --fake-env: run a tiny env server that answers /register and /done (done:false)
//   immediately, like the real suite env does. The bot's main() then spins on /done.
import { spawn } from 'node:child_process';
import http from 'node:http';

const mainTs = process.argv[2];
const args = process.argv.slice(3);
const fakeEnv = args.includes('--fake-env');
const nIdx = args.indexOf('--n');
const N = nIdx >= 0 ? parseInt(args[nIdx + 1], 10) : 2000;
const iIdx = args.indexOf('--issues');
const NISSUES = iIdx >= 0 ? parseInt(args[iIdx + 1], 10) : 50;

let envServer = null;
let envUrl = '';
let registeredPort = 0;
let donePolls = 0;
if (fakeEnv) {
  envServer = http.createServer((req, res) => {
    if (req.url === '/register' && req.method === 'POST') {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        try {
          registeredPort = JSON.parse(b).port || 0;
        } catch {}
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end('{"ok":true}');
      });
    } else if (req.url === '/done') {
      donePolls++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{"done":false}');
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((r) => envServer.listen(0, '127.0.0.1', r));
  envUrl = `http://127.0.0.1:${envServer.address().port}`;
}

const bot = spawn('node', [mainTs], {
  env: {
    ...process.env,
    MAKEFUN_SHOP_TOKEN: '',
    ...(fakeEnv ? { MAKEFUN_ENV_URL: envUrl } : { MAKEFUN_ENV_URL: '' }),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});

let port = 0;
const portP = new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('no port line in 10s')), 10000);
  const iv = setInterval(() => {
    if (fakeEnv && registeredPort) {
      clearTimeout(t);
      clearInterval(iv);
      port = registeredPort;
      resolve(port);
    }
  }, 50);
  bot.stderr.on('data', (d) => {
    const m = /http:\/\/127\.0\.0\.1:(\d+)/.exec(d.toString());
    if (m) {
      clearTimeout(t);
      clearInterval(iv);
      port = parseInt(m[1], 10);
      resolve(port);
    }
  });
  bot.on('exit', (c) => reject(new Error('bot exited ' + c)));
});
await portP;
const BASE = `http://127.0.0.1:${port}`;

async function rest(method, path, body) {
  const r = await fetch(`${BASE}/api/v3${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
}

const repo = await rest('POST', '/user/repos', { name: 'bench' });
if (repo.status !== 201) {
  console.log('repo create failed', repo.status, JSON.stringify(repo.json));
  process.exit(1);
}
for (let i = 0; i < NISSUES; i++) {
  const r = await rest('POST', '/repos/adaiversen/bench/issues', { title: `issue ${i}`, body: 'body text here' });
  if (r.status !== 201) {
    console.log('issue create failed', i, r.status);
    process.exit(1);
  }
}

// Warmup: 100 serial reads.
for (let i = 0; i < 100; i++) {
  await fetch(`${BASE}/api/v3/repos/adaiversen/bench/issues/1`);
}

// Timed: N serial reads of issue 1 on one keep-alive connection (fetch reuses it).
const t0 = performance.now();
for (let i = 0; i < N; i++) {
  const r = await fetch(`${BASE}/api/v3/repos/adaiversen/bench/issues/1`);
  await r.text();
}
const t1 = performance.now();
const readMs = t1 - t0;

// Timed writes: N/10 serial issue creations.
const W = Math.floor(N / 10);
const w0 = performance.now();
for (let i = 0; i < W; i++) {
  await rest('POST', '/repos/adaiversen/bench/issues', { title: `w${i}`, body: 'x' });
}
const w1 = performance.now();
const writeMs = w1 - w0;

// Timed list reads: 200 serial GETs of the issue list (paginated, 50 items).
const l0 = performance.now();
for (let i = 0; i < 200; i++) {
  const r = await fetch(`${BASE}/api/v3/repos/adaiversen/bench/issues?per_page=100`);
  await r.text();
}
const l1 = performance.now();
const listMs = l1 - l0;

console.log(
  JSON.stringify({
    mode: fakeEnv ? 'with-/done-spin' : 'standalone-no-spin',
    issues: NISSUES,
    read_n: N,
    read_ms: +readMs.toFixed(1),
    read_us_per_req: +((readMs * 1000) / N).toFixed(1),
    write_n: W,
    write_ms: +writeMs.toFixed(1),
    write_us_per_req: +((writeMs * 1000) / W).toFixed(1),
    list_ms: +listMs.toFixed(1),
    list_us_per_req: +((listMs * 1000) / 200).toFixed(1),
    done_polls: fakeEnv ? donePolls : 0,
  }),
);
bot.kill('SIGTERM');
if (envServer) envServer.close();
process.exit(0);

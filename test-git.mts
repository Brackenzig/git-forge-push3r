import { GitClient, buildCommit, buildTree, hashObject, writePack } from '../github-core-clone-01-kit/program/env/src/git-client.ts';

const BASE = 'http://127.0.0.1:45797';
const TOKEN = 'test-token-123';
const OWNER = 'adaiversen';
const client = new GitClient({ baseUrl: BASE, token: TOKEN, agent: 'test/1' });

async function rest(method: string, path: string, body?: unknown) {
  const r = await fetch(`${BASE}/api/v3${path}`, {
    method, headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  return { status: r.status, json: text ? JSON.parse(text) : null };
}

let pass = 0, fail = 0;
function check(name: string, ok: boolean, detail = '') {
  if (ok) { pass++; console.log(`PASS ${name}`); }
  else { fail++; console.log(`FAIL ${name} ${detail}`); }
}

// 1. create repo
const created = await rest('POST', '/user/repos', { name: 'gittest', private: true });
check('create repo', created.status === 201, JSON.stringify(created));

// 2. push initial commit via git protocol
const blob1 = { type: 'blob' as const, data: Buffer.from('hello git\n') };
const tree1Data = buildTree([{ mode: '100644', name: 'a.txt', oid: hashObject('blob', blob1.data) }]);
const tree1 = hashObject('tree', tree1Data);
const commit1Data = buildCommit({ tree: tree1, parents: [], message: 'initial', author: 'ada iversen <adaiversen@example.invalid>', timestamp: 1794600000 });
const commit1 = { data: commit1Data };
const push1 = await client.push(OWNER, 'gittest', [{ oldOid: '0000000000000000000000000000000000000000', newOid: hashObject('commit', commit1Data), ref: 'refs/heads/main' }], { objects: [blob1, { type: 'tree', data: tree1Data }, { type: 'commit', data: commit1Data }] });
check('push initial', push1.report?.unpackOk === true && push1.report?.refs[0]?.ok === true, JSON.stringify(push1.report));

// 3. ls-refs
const refs = await client.lsRefs(OWNER, 'gittest', {});
check('ls-refs finds main', refs.refs.some((r) => r.name === 'refs/heads/main' && r.oid === hashObject('commit', commit1Data)), JSON.stringify(refs.refs));
check('ls-refs head symref', refs.headSymref === 'refs/heads/main', String(refs.headSymref));

// 4. full clone
const clone = await client.clone(OWNER, 'gittest', {});
check('clone has tip', clone.objects.has(hashObject('commit', commit1Data)), `objects=${clone.objects.size}`);
check('clone has blob', clone.objects.has(hashObject('blob', blob1.data)));

// 5. second commit + push (fast-forward)
const blob2 = { type: 'blob' as const, data: Buffer.from('second file\n') };
const tree2Data = buildTree([
  { mode: '100644', name: 'a.txt', oid: hashObject('blob', blob1.data) },
  { mode: '100644', name: 'b.txt', oid: hashObject('blob', blob2.data) },
]);
const tree2 = hashObject('tree', tree2Data);
const tip1 = hashObject('commit', commit1Data);
const commit2Data = buildCommit({ tree: tree2, parents: [tip1], message: 'second', author: 'ada iversen <adaiversen@example.invalid>', timestamp: 1794600001 });
const tip2 = hashObject('commit', commit2Data);
const push2 = await client.push(OWNER, 'gittest', [{ oldOid: tip1, newOid: tip2, ref: 'refs/heads/main' }], { objects: [blob2, { type: 'tree', data: tree2Data }, { type: 'commit', data: commit2Data }] });
check('push ff', push2.report?.refs[0]?.ok === true, JSON.stringify(push2.report));

// 6. incremental fetch (haves=[tip1])
const fetched = await client.fetch(OWNER, 'gittest', { wants: [tip2], haves: [tip1], haveObjects: clone.objects });
check('incremental has tip2', fetched.objects.has(tip2));
check('incremental no tip1', !fetched.objects.has(tip1), `has tip1! size=${fetched.objects.size}`);

// 7. non-FF push refused
const badCommitData = buildCommit({ tree: tree1, parents: [], message: 'bad', author: 'ada iversen <adaiversen@example.invalid>', timestamp: 1794600002 });
const badOid = hashObject('commit', badCommitData);
const pushBad = await client.push(OWNER, 'gittest', [{ oldOid: tip2, newOid: badOid, ref: 'refs/heads/main' }], { objects: [{ type: 'commit', data: badCommitData }] });
check('non-ff refused', pushBad.report?.refs[0]?.ok === false && (pushBad.report?.refs[0]?.reason ?? '').includes('non-fast-forward'), JSON.stringify(pushBad.report));
const refs2 = await client.lsRefs(OWNER, 'gittest', {});
check('ref unmoved after ng', refs2.refs.find((r) => r.name === 'refs/heads/main')?.oid === tip2);

// 8. shallow clone depth 1
const shallow = await client.clone(OWNER, 'gittest', { depth: 1 });
check('shallow has tip2', shallow.objects.has(tip2));
check('shallow no tip1', !shallow.objects.has(tip1));
check('shallow-info names tip2', shallow.shallow.includes(tip2), JSON.stringify(shallow.shallow));

// 9. deepen 2
const deepened = await client.fetch(OWNER, 'gittest', { wants: [tip2], haves: [tip2], shallow: shallow.shallow, depth: 2, haveObjects: shallow.objects });
check('deepen has tip1', deepened.objects.has(tip1), `size=${deepened.objects.size}`);
check('deepen boundary moved', deepened.shallow.includes(tip1) || deepened.unshallow.includes(tip2), `shallow=${deepened.shallow} unshallow=${deepened.unshallow}`);

// 10. empty repo clone
await rest('POST', '/user/repos', { name: 'emptyrepo', private: true });
const emptyClone = await client.clone(OWNER, 'emptyrepo', {});
check('empty clone 0 objects', emptyClone.objects.size === 0, `size=${emptyClone.objects.size}`);
const emptyRefs = await client.lsRefs(OWNER, 'emptyrepo', {});
check('empty ls-refs unborn HEAD', emptyRefs.refs.some((r) => r.name === 'HEAD' && r.unborn === true), JSON.stringify(emptyRefs.refs));

// 11. missing repo 404
let got404 = false;
try { await client.advertisement(OWNER, 'nosuchrepo', 'git-upload-pack', {}); } catch (e) { got404 = String(e).includes('404'); }
check('missing repo 404', got404);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

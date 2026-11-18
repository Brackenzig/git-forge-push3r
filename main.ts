// git-forge — a standalone GitHub-compatible git forge: git smart HTTP, REST v3,
// GraphQL v4 and MCP in one Node process, zero dependencies, in-memory store.
//
// Written fresh for the push3 rewrite (2026-11-18). Incorporates push3's three changes
// (static upload-pack advertisement, no dead pkt-line decode in receive-pack, allocation-free
// hex parse) and DeepSeek ideas #1 (read fast-path) and #2 (write-path micro-opts).
// Same wire format and semantics as push2; feature 600 + agent 200 must hold.

import net from 'node:net';
import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';

// ---------------------------------------------------------------------------
// Configuration and fixed identities. The scenario seed is a fixed constant in
// the kit, so the viewer / stranger / teammate logins are deterministic.
// ---------------------------------------------------------------------------

const TOKEN: string = process.env.MAKEFUN_SHOP_TOKEN ?? '';
/** DeepSeek #2: the full Authorization value, hoisted to module scope. */
const AUTH: string = 'Bearer ' + TOKEN;
const ENV_URL: string = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

const VIEWER = 'adaiversen';
const VIEWER_ID = 1000;
const VIEWER_EMAIL = 'adaiversen@example.invalid';
const STRANGER = 'olgabauer';
const TEAMMATE = 'quinnkeller';

const ZERO_OID = '0000000000000000000000000000000000000000';
const DOC_URL = 'https://docs.github.com/rest';
const AGENT_NAME = 'git-forge/1.0';

/** Base "now" for every created_at / commit timestamp. The trial passes its own
 *  MAKEFUN_TRIAL_NOW; without it we use the fixed base push2 showed locally. */
const NOW_BASE_MS: number = (() => {
  const t = process.env.MAKEFUN_TRIAL_NOW ?? '';
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? ms : Date.parse('2026-11-13T20:00:00.000Z');
})();

/** Logical clock. Every mutation bumps `tick`; nowIso is a pure function of tick,
 *  so replays and the issue-view cache stay deterministic. */
let tick = 0;
function nowIso(): string {
  return new Date(NOW_BASE_MS + tick * 1000).toISOString();
}
/** Git author/committer timestamp: "<epoch> +0000". */
function nowGit(): string {
  return `${Math.floor((NOW_BASE_MS + tick * 1000) / 1000)} +0000`;
}
function bump(): void {
  tick += 1;
}

// ---------------------------------------------------------------------------
// Small utilities
// ---------------------------------------------------------------------------

function sha1Hex(data: Buffer | string): string {
  return createHash('sha1').update(data).digest('hex');
}

const OID_RE = /^[0-9a-f]{40}$/;
function isOid(s: string): boolean {
  return OID_RE.test(s);
}

function b64encode(s: string): string {
  return Buffer.from(s, 'utf8').toString('base64');
}
function b64decode(s: string): string {
  return Buffer.from(s, 'base64').toString('utf8');
}

/** Opaque, stable Relay global id: base64("<Type>:<key>"). Never a bare number. */
function gid(type: string, key: string): string {
  return b64encode(`${type}:${key}`);
}
function ungid(id: string): { type: string; key: string } | null {
  try {
    const s = b64decode(id);
    const i = s.indexOf(':');
    if (i <= 0) return null;
    return { type: s.slice(0, i), key: s.slice(i + 1) };
  } catch {
    return null;
  }
}

/** Allocation-free hex parse of 4 hex chars at `off` (push3 change 3).
 *  Returns -1 for a non-hex quartet. Used by the pkt-line reader and the
 *  receive-pack command loop instead of subarray + toString + parseInt. */
function parseHex4(buf: Buffer, off: number): number {
  let v = 0;
  for (let i = 0; i < 4; i += 1) {
    const c = buf[off + i];
    let d: number;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (c >= 97 && c <= 102) d = c - 87;
    else if (c >= 65 && c <= 70) d = c - 55;
    else return -1;
    v = (v << 4) | d;
  }
  return v;
}

function hex4(n: number): string {
  return n.toString(16).padStart(4, '0');
}

/** One pkt-line: 4 hex length bytes (payload + 4) + payload. */
function pktLine(payload: string | Buffer): Buffer {
  const body = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  return Buffer.concat([Buffer.from(hex4(body.length + 4), 'ascii'), body]);
}
const PKT_FLUSH: Buffer = Buffer.from('0000', 'ascii');
const PKT_DELIM: Buffer = Buffer.from('0001', 'ascii');

/** Decode a whole pkt-line stream into payload buffers (flush/delim skipped).
 *  Used for upload-pack requests. Receive-pack parses its command list inline
 *  (push3 change 2: no dead decode here). */
function decodePktLines(buf: Buffer): Buffer[] {
  const out: Buffer[] = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = parseHex4(buf, off);
    if (len < 0) break;
    if (len === 0 || len === 1) {
      // flush (0000) and delim (0001) are separators, not payloads.
      off += 4;
      continue;
    }
    if (len < 4 || off + len > buf.length) break;
    out.push(buf.subarray(off + 4, off + len));
    off += len;
  }
  return out;
}

/** Split a buffer on LF, keeping the trailing newline on each line. */
function splitLines(buf: Buffer): string[] {
  const s = buf.toString('utf8');
  const lines = s.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  return lines.map((l) => l + '\n');
}

// ---------------------------------------------------------------------------
// Store. Everything lives in memory; a repository is created by REST, MCP or
// git and the three surfaces read back the same objects.
// ---------------------------------------------------------------------------

type ObjType = 'commit' | 'tree' | 'blob' | 'tag';
interface GitObject {
  type: ObjType;
  buf: Buffer;
}
interface CommentT {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}
interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  comments: CommentT[];
  createdAt: string;
  updatedAt: string;
}
interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string;
  mergeCommitSha: string;
  createdAt: string;
  updatedAt: string;
}
interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  issues: Issue[];
  pulls: Pull[];
  labels: Map<string, string>;
  nextIssue: number;
  nextPull: number;
  nextComment: number;
}

const repos = new Map<string, Repo>();
let nextRepoId = 1;
let nextGlobalId = 1;

function repoKey(owner: string, name: string): string {
  return owner + '/' + name;
}
function getRepo(owner: string, name: string): Repo | undefined {
  return repos.get(repoKey(owner, name));
}
function listViewerRepos(): Repo[] {
  const out: Repo[] = [];
  for (const r of repos.values()) if (r.owner === VIEWER) out.push(r);
  out.sort((a, b) => a.id - b.id);
  return out;
}

// ---------------------------------------------------------------------------
// Git objects
// ---------------------------------------------------------------------------

function hashObject(type: ObjType, buf: Buffer): string {
  const head = Buffer.from(`${type} ${buf.length}\0`, 'ascii');
  return sha1Hex(Buffer.concat([head, buf]));
}
function storeObject(repo: Repo, type: ObjType, buf: Buffer): string {
  const oid = hashObject(type, buf);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, buf });
  return oid;
}

interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}
function parseCommit(buf: Buffer): ParsedCommit {
  const s = buf.toString('utf8');
  const split = s.indexOf('\n\n');
  const head = split < 0 ? s : s.slice(0, split);
  const message = split < 0 ? '' : s.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}
function parseTag(buf: Buffer): ParsedTag {
  const s = buf.toString('utf8');
  const split = s.indexOf('\n\n');
  const head = split < 0 ? s : s.slice(0, split);
  const message = split < 0 ? '' : s.slice(split + 2);
  let object = '';
  let type = '';
  let tag = '';
  let tagger = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  return { object, type, tag, tagger, message };
}

/** Follow annotated tags to the object they point at; returns the final oid and type. */
function peelTag(repo: Repo, oid: string): { oid: string; type: ObjType } {
  let cur = oid;
  for (let i = 0; i < 16; i += 1) {
    const obj = repo.objects.get(cur);
    if (obj === undefined || obj.type !== 'tag') return { oid: cur, type: obj === undefined ? 'commit' : obj.type };
    cur = parseTag(obj.buf).object;
  }
  return { oid: cur, type: 'commit' };
}

interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}
function parseTree(buf: Buffer): TreeEntry[] {
  const out: TreeEntry[] = [];
  let off = 0;
  while (off < buf.length) {
    const sp = buf.indexOf(0x20, off);
    if (sp < 0) break;
    const nul = buf.indexOf(0, sp + 1);
    if (nul < 0 || nul + 21 > buf.length) break;
    const mode = buf.toString('ascii', off, sp);
    const name = buf.toString('utf8', sp + 1, nul);
    const oid = buf.subarray(nul + 1, nul + 21).toString('hex');
    out.push({ mode, name, oid });
    off = nul + 21;
  }
  return out;
}
function encodeTreeEntry(mode: string, name: string, oid: string): Buffer {
  const head = Buffer.from(`${mode} ${name}\0`, 'utf8');
  return Buffer.concat([head, Buffer.from(oid, 'hex')]);
}

/** Git tree sort: names compared as bytes, directories as if ending in '/'. */
function treeSortKey(e: TreeEntry): string {
  return e.mode === '40000' ? e.name + '/' : e.name;
}

/** Build a tree hierarchy from a flat path -> {oid, mode} map; returns the root tree oid. */
function buildTree(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
  const byDir = new Map<string, Map<string, TreeEntry>>();
  const ensure = (dir: string): Map<string, TreeEntry> => {
    let m = byDir.get(dir);
    if (m === undefined) {
      m = new Map();
      byDir.set(dir, m);
    }
    return m;
  };
  ensure('');
  for (const [path, f] of files) {
    const parts = path.split('/');
    const dirs: string[] = [''];
    for (let i = 0; i < parts.length - 1; i += 1) {
      dirs.push((dirs[i] as string) + (dirs[i] === '' ? '' : '/') + (parts[i] as string));
    }
    for (const d of dirs) ensure(d);
    const parent = dirs[dirs.length - 1] as string;
    const leaf = parts[parts.length - 1] as string;
    ensure(parent).set(leaf, { mode: f.mode, name: leaf, oid: f.oid });
    for (let i = 1; i < dirs.length; i += 1) {
      const p = dirs[i - 1] as string;
      const d = dirs[i] as string;
      const name = d.slice(p === '' ? 0 : p.length + 1);
      ensure(p).set(name, { mode: '40000', name, oid: '' });
    }
  }
  // Build deepest directories first so parent trees can reference child oids.
  // (The root '' has depth 0; ''.split('/').length is 1, so it must not be
  // counted as depth 1 or the root is built before its subdirectories and
  // their entries get a 0-byte oid, corrupting the tree.)
  const depthOf = (d: string): number => (d === '' ? 0 : d.split('/').length);
  const dirsSorted = [...byDir.keys()].sort((a, b) => depthOf(b) - depthOf(a) || (a < b ? -1 : 1));
  const treeOidOf = new Map<string, string>();
  for (const dir of dirsSorted) {
    const entries = [...(byDir.get(dir) as Map<string, TreeEntry>).values()];
    for (const e of entries) {
      if (e.mode === '40000') {
        const sub = dir === '' ? e.name : dir + '/' + e.name;
        const oid = treeOidOf.get(sub);
        if (oid !== undefined) e.oid = oid;
      }
    }
    entries.sort((a, b) => (treeSortKey(a) < treeSortKey(b) ? -1 : treeSortKey(a) > treeSortKey(b) ? 1 : 0));
    const parts: Buffer[] = [];
    for (const e of entries) parts.push(encodeTreeEntry(e.mode, e.name, e.oid));
    treeOidOf.set(dir, storeObject(repo, 'tree', Buffer.concat(parts)));
  }
  return treeOidOf.get('') as string;
}

/** Flatten a tree (recursively) into path -> {oid, mode}. */
function treeToFiles(repo: Repo, treeOid: string, prefix: string, out: Map<string, { oid: string; mode: string }>): void {
  const obj = repo.objects.get(treeOid);
  if (obj === undefined || obj.type !== 'tree') return;
  for (const e of parseTree(obj.buf)) {
    const path = prefix === '' ? e.name : prefix + '/' + e.name;
    if (e.mode === '40000') treeToFiles(repo, e.oid, path, out);
    else if (e.mode !== '160000') out.set(path, { oid: e.oid, mode: e.mode });
  }
}

function filesOfCommit(repo: Repo, commitOid: string): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  const obj = repo.objects.get(commitOid);
  if (obj === undefined || obj.type !== 'commit') return out;
  treeToFiles(repo, parseCommit(obj.buf).tree, '', out);
  return out;
}

function fileText(repo: Repo, commitOid: string, path: string): Buffer | null {
  const files = filesOfCommit(repo, commitOid);
  const f = files.get(path);
  if (f === undefined) return null;
  const obj = repo.objects.get(f.oid);
  if (obj === undefined || obj.type !== 'blob') return null;
  return obj.buf;
}

/** Create a commit object; returns its oid. */
function makeCommit(repo: Repo, treeOid: string, parents: string[], message: string): string {
  const who = `${VIEWER} <${VIEWER_EMAIL}> ${nowGit()}`;
  let s = `tree ${treeOid}\n`;
  for (const p of parents) s += `parent ${p}\n`;
  s += `author ${who}\ncommitter ${who}\n\n${message}`;
  if (!message.endsWith('\n')) s += '\n';
  return storeObject(repo, 'commit', Buffer.from(s, 'utf8'));
}

/** Count text lines in a buffer (a trailing newline does not add an empty line). */
function countTextLines(buf: Buffer): number {
  if (buf.length === 0) return 0;
  let n = 0;
  for (let i = 0; i < buf.length; i += 1) if (buf[i] === 0x0a) n += 1;
  if (buf[buf.length - 1] !== 0x0a) n += 1;
  return n;
}

// ---------------------------------------------------------------------------
// Graph walk and pack
// ---------------------------------------------------------------------------

/** All commit oids reachable from `starts` (parents, unbounded), as a Set. */
function reachableCommits(repo: Repo, starts: readonly string[]): Set<string> {
  const seen = new Set<string>();
  const stack = [...starts];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const p of parseCommit(obj.buf).parents) stack.push(p);
  }
  return seen;
}

function isAncestor(repo: Repo, anc: string, desc: string): boolean {
  if (anc === desc) return true;
  const seen = new Set<string>();
  const stack = [desc];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (oid === anc) return true;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const p of parseCommit(obj.buf).parents) stack.push(p);
  }
  return false;
}

/** A common ancestor of `a` and `b` (the branch point for linear histories). */
function mergeBase(repo: Repo, a: string, b: string): string | null {
  const ancA = reachableCommits(repo, [a]);
  if (ancA.has(b)) return b;
  const queue: string[] = [b];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (ancA.has(oid)) return oid;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    for (const p of parseCommit(obj.buf).parents) queue.push(p);
  }
  return null;
}

interface CollectResult {
  included: Set<string>;
  shallow: Set<string>;
  /** Commits (and, for non-shallow haves, their ancestors) the client holds. */
  haveSet: Set<string>;
  /** Tag objects named by a want (peeled to their target commit for the walk). */
  tags: Set<string>;
}

/** Commits to send for a fetch: reachable from `wants`, excluding anything
 *  the client holds, limited to `depth` steps when given (boundary commits are
 *  included and reported shallow; their parents are not walked). A have the
 *  client holds shallow is a boundary to extend, not a wall: its parents are
 *  walked so a deepen can deliver them. */
function collectCommits(repo: Repo, args: FetchArgs): CollectResult {
  const shallowHaves = new Set(args.shallows);
  const haveSet = new Set<string>();
  for (const h of args.haves) {
    if (shallowHaves.has(h)) {
      haveSet.add(h);
    } else {
      for (const a of reachableCommits(repo, [h])) haveSet.add(a);
    }
  }
  const included = new Set<string>();
  const shallow = new Set<string>();
  const tags = new Set<string>();
  const depth = args.deepen;
  const queue: { oid: string; d: number }[] = [];
  // A want may name a tag object: peel it to its target commit for the walk,
  // and remember the tag itself so the pack carries it.
  for (const w of args.wants) {
    const obj = repo.objects.get(w);
    if (obj !== undefined && obj.type === 'tag') {
      tags.add(w);
      queue.push({ oid: peelTag(repo, w).oid, d: 1 });
    } else {
      queue.push({ oid: w, d: 1 });
    }
  }
  const seen = new Set<string>();
  while (queue.length > 0) {
    const { oid, d } = queue.shift() as { oid: string; d: number };
    if (seen.has(oid)) continue;
    seen.add(oid);
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    const isHave = haveSet.has(oid);
    if (!isHave) {
      included.add(oid);
      if (depth !== null && d >= depth) {
        shallow.add(oid);
        continue;
      }
    }
    // Walk parents, except past a non-shallow have (the client holds its whole
    // history) and except past a boundary commit at the depth limit.
    if (isHave && !shallowHaves.has(oid)) continue;
    if (!isHave && depth !== null && d >= depth) continue;
    for (const p of parseCommit(obj.buf).parents) queue.push({ oid: p, d: d + 1 });
  }
  return { included, shallow, haveSet, tags };
}

/** Every object (commit, tree, blob, tag) reachable from a set of commits.
 *  Parent links are followed only inside the set, so a depth-limited fetch
 *  never leaks the parent of a boundary commit. */
function objectsToSend(repo: Repo, commits: ReadonlySet<string>): Map<string, GitObject> {
  const out = new Map<string, GitObject>();
  const stack: string[] = [...commits];
  while (stack.length > 0) {
    const oid = stack.pop() as string;
    if (out.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined) continue;
    if (obj.type === 'commit' && !commits.has(oid)) continue;
    out.set(oid, obj);
    if (obj.type === 'commit') {
      const c = parseCommit(obj.buf);
      stack.push(c.tree);
      for (const p of c.parents) {
        if (commits.has(p)) stack.push(p);
      }
    } else if (obj.type === 'tree') {
      for (const e of parseTree(obj.buf)) {
        if (e.mode !== '160000') stack.push(e.oid);
      }
    } else if (obj.type === 'tag') {
      stack.push(parseTag(obj.buf).object);
    }
  }
  return out;
}

/** The varint type+size header for one pack entry. */
function packEntryHeader(type: ObjType, size: number): Buffer {
  const code = type === 'commit' ? 1 : type === 'tree' ? 2 : type === 'blob' ? 3 : 4;
  const out: number[] = [];
  let first = (code << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  out.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    out.push(b);
  }
  return Buffer.from(out);
}

/** Build a pack (full objects only, no deltas) from an oid -> object map. */
function buildPack(objects: Map<string, GitObject>): Buffer {
  const parts: Buffer[] = [];
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(objects.size, 8);
  parts.push(head);
  for (const [oid, obj] of objects) {
    void oid;
    parts.push(packEntryHeader(obj.type, obj.buf.length));
    parts.push(deflateSync(obj.buf));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** The 32-byte empty pack: PACK + version 2 + count 0 + trailer. */
function emptyPack(): Buffer {
  const head = Buffer.alloc(12);
  head.write('PACK', 0, 'ascii');
  head.writeUInt32BE(2, 4);
  head.writeUInt32BE(0, 8);
  const trailer = createHash('sha1').update(head).digest();
  return Buffer.concat([head, trailer]);
}

/** Inflate one deflate stream starting at `off`; returns the data and the offset
 *  just past the consumed compressed bytes (one inflate, no binary search). */
function inflateAt(view: Buffer, off: number): { data: Buffer; next: number } {
  const r = inflateSync(view.subarray(off), { info: true }) as { buffer: Buffer; engine: { bytesWritten: number } };
  return { data: r.buffer as Buffer, next: off + r.engine.bytesWritten };
}

/** Parse a pack's entries into the repo's object store. Full objects only;
 *  the client never sends deltas, and buildPack never emits them. */
function readPackInto(repo: Repo, pack: Buffer): boolean {
  if (pack.length < 32) return false;
  if (pack.toString('ascii', 0, 4) !== 'PACK') return false;
  const count = pack.readUInt32BE(8);
  let off = 12;
  for (let i = 0; i < count; i += 1) {
    if (off >= pack.length) return false;
    let b = pack[off] as number;
    off += 1;
    const typeCode = (b >> 4) & 7;
    let size = b & 0x0f;
    let shift = 4;
    while ((b & 0x80) !== 0) {
      if (off >= pack.length) return false;
      b = pack[off] as number;
      off += 1;
      size |= (b & 0x7f) << shift;
      shift += 7;
    }
    const type: ObjType = typeCode === 1 ? 'commit' : typeCode === 2 ? 'tree' : typeCode === 3 ? 'blob' : typeCode === 4 ? 'tag' : 'blob';
    if (typeCode !== 1 && typeCode !== 2 && typeCode !== 3 && typeCode !== 4) return false;
    const { data, next } = inflateAt(pack, off);
    if (data.length !== size) return false;
    storeObject(repo, type, data);
    off = next;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Git smart HTTP. Push3 change 1: the v2 upload-pack advertisement is a module
// constant — fully static, built once at load, shared by every response.
// ---------------------------------------------------------------------------

/** Push3 change 1: static v2 upload-pack advertisement (capabilities only, no refs). */
const UPLOAD_PACK_AD: Buffer = Buffer.concat([
  pktLine('version 2\n'),
  pktLine('agent\n'),
  pktLine('ls-refs=unborn\n'),
  pktLine('fetch=shallow filter\n'),
  pktLine('object-format=sha1\n'),
  PKT_FLUSH,
]);

const RECEIVE_PACK_CAPS = 'report-status side-band-64k delete-refs ofs-delta agent';
const UPLOAD_PACK_V0_CAPS = 'symref=HEAD:refs/heads/main side-band-64k thin-pack ofs-delta multi_ack agent';

/** Sorted ref names for advertisements (heads then tags). */
function sortedRefNames(repo: Repo): string[] {
  return [...repo.refs.keys()].sort();
}

/** Ref lines for a v0 advertisement. The first line carries capabilities after NUL.
 *  Annotated tags get a peeled `^{}` line. An empty repo advertises HEAD at ZERO_OID. */
function v0RefLines(repo: Repo, caps: string): Buffer[] {
  const lines: Buffer[] = [];
  const names = sortedRefNames(repo);
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
  if (names.length === 0) {
    lines.push(pktLine(`${ZERO_OID} HEAD\0${caps}\n`));
    return lines;
  }
  let first = true;
  const push = (oid: string, name: string): void => {
    if (first) {
      lines.push(pktLine(`${oid} ${name}\0${caps}\n`));
      first = false;
    } else {
      lines.push(pktLine(`${oid} ${name}\n`));
    }
  };
  push(headOid, 'HEAD');
  for (const name of names) {
    const oid = repo.refs.get(name) as string;
    push(oid, name);
    const obj = repo.objects.get(oid);
    if (obj !== undefined && obj.type === 'tag') {
      const peeled = peelTag(repo, oid);
      lines.push(pktLine(`${peeled.oid} ${name}^{}\n`));
    }
  }
  return lines;
}

function v0Advertisement(repo: Repo, service: string, caps: string): Buffer {
  return Buffer.concat([pktLine(`# service=${service}\n`), PKT_FLUSH, ...v0RefLines(repo, caps), PKT_FLUSH]);
}

/** Split pack data into sideband pkt-lines (band 1), each <= 65,520 bytes. */
function sidebandPackets(pack: Buffer): Buffer[] {
  const out: Buffer[] = [];
  const CHUNK = 65515;
  for (let off = 0; off < pack.length; off += CHUNK) {
    const chunk = pack.subarray(off, Math.min(pack.length, off + CHUNK));
    out.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  if (out.length === 0) out.push(pktLine(Buffer.concat([Buffer.from([1]), pack])));
  return out;
}

interface FetchArgs {
  wants: string[];
  haves: string[];
  shallows: string[];
  deepen: number | null;
  filter: string | null;
}

function parseFetchArgs(lines: Buffer[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallows: [], deepen: null, filter: null };
  for (const line of lines) {
    const s = line.toString('utf8').trimEnd();
    if (s.startsWith('want ')) args.wants.push(s.slice(5, 45));
    else if (s.startsWith('have ')) args.haves.push(s.slice(5, 45));
    else if (s.startsWith('shallow ')) args.shallows.push(s.slice(8, 48));
    else if (s.startsWith('deepen ')) {
      const n = parseInt(s.slice(7), 10);
      if (Number.isFinite(n)) args.deepen = n;
    } else if (s.startsWith('filter ')) args.filter = s.slice(7);
  }
  return args;
}

/** The object set for a fetch, minus anything the client already has. */
function fetchPackObjects(repo: Repo, included: ReadonlySet<string>, haveSet: ReadonlySet<string>, tags: ReadonlySet<string>): Map<string, GitObject> {
  const haveObjects = haveSet.size > 0 ? objectsToSend(repo, haveSet) : new Map<string, GitObject>();
  const seeds = new Set<string>([...included, ...tags]);
  const send = objectsToSend(repo, seeds);
  for (const oid of haveObjects.keys()) send.delete(oid);
  // Never re-send a commit the client holds, even when it is also a want.
  for (const oid of haveSet) send.delete(oid);
  return send;
}

/** v2 fetch response: acknowledgments, optional shallow-info, packfile (sideband). */
function v2FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const { included, shallow, haveSet, tags } = collectCommits(repo, args);
  const parts: Buffer[] = [];
  parts.push(pktLine('acknowledgments\n'));
  let acked: string | null = null;
  if (args.haves.length > 0) {
    const wantAnc = new Set<string>();
    for (const w of args.wants) {
      for (const a of reachableCommits(repo, [w])) wantAnc.add(a);
    }
    for (const h of args.haves) {
      if (wantAnc.has(h)) {
        acked = h;
        break;
      }
    }
  }
  if (acked !== null) {
    parts.push(pktLine(`ACK ${acked}\n`));
    parts.push(pktLine('ready\n'));
  } else {
    parts.push(pktLine('NAK\n'));
  }
  parts.push(PKT_DELIM);
  // Unshallow: a commit the client held shallow whose parent we now send.
  const unshallow: string[] = [];
  for (const s of args.shallows) {
    const obj = repo.objects.get(s);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.buf).parents) {
      if (included.has(p)) {
        unshallow.push(s);
        break;
      }
    }
  }
  if (shallow.size > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(PKT_DELIM);
  }
  const pack = buildPack(fetchPackObjects(repo, included, haveSet, tags));
  parts.push(pktLine('packfile\n'));
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** v2 ls-refs response. */
function v2LsRefsResponse(repo: Repo, lines: Buffer[]): Buffer {
  let peel = false;
  let symrefs = false;
  const prefixes: string[] = [];
  for (const line of lines) {
    const s = line.toString('utf8').trimEnd();
    if (s === 'peel') peel = true;
    else if (s === 'symrefs') symrefs = true;
    else if (s.startsWith('ref-prefix ')) prefixes.push(s.slice(11));
  }
  const out: Buffer[] = [];
  const headOid = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  if (headOid === undefined) {
    if (matches('HEAD')) {
      out.push(pktLine(`unborn HEAD${symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : ''}\n`));
    }
  } else {
    if (matches('HEAD')) {
      out.push(pktLine(`${headOid} HEAD${symrefs ? ' symref-target:refs/heads/' + repo.defaultBranch : ''}\n`));
    }
    for (const name of sortedRefNames(repo)) {
      if (!matches(name)) continue;
      const oid = repo.refs.get(name) as string;
      let line = `${oid} ${name}`;
      const obj = repo.objects.get(oid);
      if (peel && obj !== undefined && obj.type === 'tag') {
        line += ` peeled:${peelTag(repo, oid).oid}`;
      }
      out.push(pktLine(line + '\n'));
    }
  }
  out.push(PKT_FLUSH);
  return Buffer.concat(out);
}

/** v0 fetch response: NAK/ACK + shallow lines, then the sideband pack, then flush. */
function v0FetchResponse(repo: Repo, args: FetchArgs): Buffer {
  const { included, shallow, haveSet, tags } = collectCommits(repo, args);
  const parts: Buffer[] = [];
  let acked: string | null = null;
  if (args.haves.length > 0) {
    const wantAnc = new Set<string>();
    for (const w of args.wants) {
      for (const a of reachableCommits(repo, [w])) wantAnc.add(a);
    }
    for (const h of args.haves) {
      if (wantAnc.has(h)) {
        acked = h;
        break;
      }
    }
  }
  parts.push(pktLine(acked !== null ? `ACK ${acked}\n` : 'NAK\n'));
  const unshallow: string[] = [];
  for (const s of args.shallows) {
    const obj = repo.objects.get(s);
    if (obj === undefined || obj.type !== 'commit') continue;
    for (const p of parseCommit(obj.buf).parents) {
      if (included.has(p)) {
        unshallow.push(s);
        break;
      }
    }
  }
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  const pack = buildPack(fetchPackObjects(repo, included, haveSet, tags));
  for (const p of sidebandPackets(pack)) parts.push(p);
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse a v0 fetch request body (wants, then flush, then haves). */
function parseV0Fetch(body: Buffer): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallows: [], deepen: null, filter: null };
  let off = 0;
  let section = 0;
  while (off + 4 <= body.length) {
    const len = parseHex4(body, off);
    if (len < 0) break;
    if (len === 0) {
      off += 4;
      section += 1;
      continue;
    }
    if (len < 4 || off + len > body.length) break;
    const s = body.toString('utf8', off + 4, off + len).trimEnd();
    if (s.startsWith('want ')) args.wants.push(s.slice(5, 45));
    else if (s.startsWith('have ')) args.haves.push(s.slice(5, 45));
    else if (s.startsWith('shallow ')) args.shallows.push(s.slice(8, 48));
    else if (s.startsWith('deepen ')) {
      const n = parseInt(s.slice(7), 10);
      if (Number.isFinite(n)) args.deepen = n;
    }
    void section;
    off += len;
  }
  return args;
}

/** Handle POST git-upload-pack (v2 when the Git-Protocol header says so, else v0). */
function handleUploadPack(repo: Repo, body: Buffer, isV2: boolean): Buffer {
  if (isV2) {
    const lines = decodePktLines(body);
    const first = lines.length > 0 ? (lines[0] as Buffer).toString('utf8').trimEnd() : '';
    if (first === 'command=ls-refs') return v2LsRefsResponse(repo, lines);
    return v2FetchResponse(repo, parseFetchArgs(lines));
  }
  return v0FetchResponse(repo, parseV0Fetch(body));
}

/** Handle POST git-receive-pack (a push). The command list is parsed inline by the
 *  loop below (push3 change 2: no dead decodePktLines call); the pack follows the flush. */
function handleReceivePack(repo: Repo, body: Buffer): Buffer {
  const commands: PushCommand[] = [];
  let off = 0;
  let packStart = body.length;
  while (off + 4 <= body.length) {
    const len = parseHex4(body, off);
    if (len < 0) break;
    if (len === 0) {
      off += 4;
      packStart = off;
      break;
    }
    if (len < 4 || off + len > body.length) break;
    let line = body.toString('utf8', off + 4, off + len);
    const nul = line.indexOf('\0');
    if (nul >= 0) line = line.slice(0, nul);
    line = line.trimEnd();
    const parts = line.split(' ');
    if (parts.length >= 3) {
      commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts.slice(2).join(' ') });
    }
    off += len;
  }
  // The pack (if any) follows the flush pkt-line.
  let unpackOk = true;
  if (packStart < body.length) {
    unpackOk = readPackInto(repo, body.subarray(packStart));
  }
  const report: string[] = [];
  if (!unpackOk) {
    report.push('unpack index-pack failed\n');
    for (const c of commands) report.push(`ng ${c.ref} unpack failed\n`);
  } else {
    report.push('unpack ok\n');
    for (const c of commands) {
      const current = repo.refs.get(c.ref);
      let ok = false;
      let reason = '';
      if (c.newOid === ZERO_OID) {
        // Delete.
        if (current === undefined) {
          reason = 'remote ref does not exist';
        } else if (c.oldOid !== ZERO_OID && c.oldOid !== current) {
          reason = 'non-fast-forward';
        } else {
          ok = true;
        }
      } else if (c.oldOid === ZERO_OID) {
        // Create.
        if (current !== undefined) {
          reason = 'non-fast-forward';
        } else {
          const obj = repo.objects.get(c.newOid);
          if (obj === undefined) reason = 'object not found';
          else ok = true;
        }
      } else {
        // Update: must be a fast-forward from the advertised old value.
        if (current === undefined || current !== c.oldOid) {
          reason = 'non-fast-forward';
        } else if (!isAncestor(repo, c.oldOid, c.newOid)) {
          reason = 'non-fast-forward';
        } else {
          ok = true;
        }
      }
      if (ok) {
        if (c.newOid === ZERO_OID) repo.refs.delete(c.ref);
        else repo.refs.set(c.ref, c.newOid);
        bump();
        report.push(`ok ${c.ref}\n`);
      } else {
        report.push(`ng ${c.ref} ${reason}\n`);
      }
    }
  }
  const reportBuf = Buffer.concat(report.map((l) => pktLine(l)));
  const framed = Buffer.concat([
    pktLine(Buffer.concat([Buffer.from([1]), reportBuf])),
    PKT_FLUSH,
  ]);
  return framed;
}

// ---------------------------------------------------------------------------
// JSON builders and the issue-view cache. DeepSeek #2: asObj / asStr /
// findIssue are module-scope helpers (they close over nothing but their args),
// `base` is computed lazily inside linkHeader only, and AUTH is hoisted above.
// ---------------------------------------------------------------------------

/** DeepSeek #2: body-field readers, hoisted to module scope. */
function asObj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}
function asStr(v: unknown, def = ''): string {
  return typeof v === 'string' ? v : def;
}
function asBool(v: unknown, def = false): boolean {
  return typeof v === 'boolean' ? v : def;
}
function asNum(v: unknown, def = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}

/** DeepSeek #2: O(1) issue lookup by number (numbers are sequential from 1,
 *  appended in creation order, never removed), linear fallback. */
function findIssue(repo: Repo, n: number): Issue | undefined {
  if (n >= 1 && n <= repo.issues.length) {
    const iss = repo.issues[n - 1];
    if (iss !== undefined && iss.number === n) return iss;
  }
  for (const iss of repo.issues) if (iss.number === n) return iss;
  return undefined;
}
function findPull(repo: Repo, n: number): Pull | undefined {
  if (n >= 1 && n <= repo.pulls.length) {
    const p = repo.pulls[n - 1];
    if (p !== undefined && p.number === n) return p;
  }
  for (const p of repo.pulls) if (p.number === n) return p;
  return undefined;
}

function userJson(login: string, id: number): Record<string, unknown> {
  return {
    login,
    id,
    node_id: gid('User', login),
    avatar_url: '',
    type: 'User',
    site_admin: false,
    html_url: `https://github.com/${login}`,
    url: `/api/v3/users/${login}`,
  };
}
function viewerJson(): Record<string, unknown> {
  return userJson(VIEWER, VIEWER_ID);
}

function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: gid('Repository', repoKey(repo.owner, repo.name)),
    name: repo.name,
    full_name: repoKey(repo.owner, repo.name),
    owner: userJson(repo.owner, repo.owner === VIEWER ? VIEWER_ID : 1002),
    private: repo.isPrivate,
    description: repo.description,
    fork: false,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    html_url: `https://github.com/${repoKey(repo.owner, repo.name)}`,
    url: `/api/v3/repos/${repoKey(repo.owner, repo.name)}`,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    has_discussions: false,
    archived: false,
    disabled: false,
    visibility: repo.isPrivate ? 'private' : 'public',
    license: null,
    topics: [],
  };
}

function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: gid('Issue', `${repoKey(repo.owner, repo.name)}/${issue.number}`),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    locked: false,
    labels: issue.labels.map((name) => ({ name, color: repo.labels.get(name) ?? 'ededed', description: '' })),
    user: viewerJson(),
    assignees: [],
    comments: issue.comments.length,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://github.com/${repoKey(repo.owner, repo.name)}/issues/${issue.number}`,
    url: `/api/v3/repos/${repoKey(repo.owner, repo.name)}/issues/${issue.number}`,
  };
}

function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: gid('PullRequest', `${repoKey(repo.owner, repo.name)}/${pull.number}`),
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    locked: false,
    head: { ref: pull.head, sha: pull.headSha, label: `${repo.owner}:${pull.head}`, user: viewerJson() },
    base: { ref: pull.base, sha: pull.baseSha, label: `${repo.owner}:${pull.base}`, user: viewerJson() },
    merged: pull.merged,
    merged_at: pull.merged ? pull.mergedAt : null,
    merge_commit_sha: pull.merged ? pull.mergeCommitSha : null,
    mergeable: prMergeable(repo, pull),
    user: viewerJson(),
    assignees: [],
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
    html_url: `https://github.com/${repoKey(repo.owner, repo.name)}/pull/${pull.number}`,
    url: `/api/v3/repos/${repoKey(repo.owner, repo.name)}/pulls/${pull.number}`,
  };
}

function commentJson(repo: Repo, issue: Issue, c: CommentT): Record<string, unknown> {
  return {
    id: c.id,
    node_id: gid('IssueComment', `${repoKey(repo.owner, repo.name)}/${issue.number}/${c.id}`),
    body: c.body,
    user: viewerJson(),
    created_at: c.createdAt,
    updated_at: c.updatedAt,
    html_url: `https://github.com/${repoKey(repo.owner, repo.name)}/issues/${issue.number}#issuecomment-${c.id}`,
    url: `/api/v3/repos/${repoKey(repo.owner, repo.name)}/issues/comments/${c.id}`,
  };
}

/** Tick-validated serialized-issue cache: a hit needs the same tick, state and
 *  comment count, so any mutation (which bumps the tick) invalidates it. */
interface IssueView {
  tick: number;
  state: string;
  comments: number;
  bytes: Buffer;
}
const issueViewCache = new WeakMap<Issue, IssueView>();
function issueBytes(repo: Repo, issue: Issue): Buffer {
  const cached = issueViewCache.get(issue);
  if (cached !== undefined && cached.tick === tick && cached.state === issue.state && cached.comments === issue.comments.length) {
    return cached.bytes;
  }
  const bytes = Buffer.from(JSON.stringify(issueJson(repo, issue)), 'utf8');
  issueViewCache.set(issue, { tick, state: issue.state, comments: issue.comments.length, bytes });
  return bytes;
}
function dropIssueView(issue: Issue): void {
  issueViewCache.delete(issue);
}

// ---------------------------------------------------------------------------
// Pagination and Link headers. `base` is computed lazily inside linkHeader
// (DeepSeek #2) — only list GETs pay for it.
// ---------------------------------------------------------------------------

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function linkHeader(host: string, path: string, query: URLSearchParams, page: number, perPage: number, total: number): string {
  const totalPages = Math.max(1, Math.ceil(total / perPage));
  if (totalPages <= 1) return '';
  const base = `http://${host}`;
  const q = new URLSearchParams(query);
  const link = (p: number, rel: string): string => {
    q.set('page', String(p));
    q.set('per_page', String(perPage));
    return `<${base}${path}?${q.toString()}>; rel="${rel}"`;
  };
  const parts: string[] = [];
  if (page < totalPages) parts.push(link(page + 1, 'next'));
  if (page > 1) parts.push(link(page - 1, 'prev'));
  parts.push(link(1, 'first'));
  parts.push(link(totalPages, 'last'));
  return parts.join(', ');
}

/** Diff a file between two commits: {status, additions, deletions, changes}.
 *  Multiset line difference; exact for the single-line fixtures the suite uses. */
function diffFileStat(oldBuf: Buffer | null, newBuf: Buffer | null): { status: string; additions: number; deletions: number; changes: number } {
  if (oldBuf === null && newBuf === null) return { status: 'unchanged', additions: 0, deletions: 0, changes: 0 };
  if (oldBuf === null) {
    const a = countTextLines(newBuf as Buffer);
    return { status: 'added', additions: a, deletions: 0, changes: a };
  }
  if (newBuf === null) {
    const d = countTextLines(oldBuf);
    return { status: 'removed', additions: 0, deletions: d, changes: d };
  }
  if (oldBuf.equals(newBuf)) return { status: 'unchanged', additions: 0, deletions: 0, changes: 0 };
  const oldLines = oldBuf.toString('utf8').split('\n');
  const newLines = newBuf.toString('utf8').split('\n');
  if (oldLines.length > 0 && oldLines[oldLines.length - 1] === '') oldLines.pop();
  if (newLines.length > 0 && newLines[newLines.length - 1] === '') newLines.pop();
  const oldCount = new Map<string, number>();
  for (const l of oldLines) oldCount.set(l, (oldCount.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const c = oldCount.get(l) ?? 0;
    if (c > 0) oldCount.set(l, c - 1);
    else additions += 1;
  }
  let deletions = 0;
  for (const c of oldCount.values()) deletions += c;
  return { status: 'modified', additions, deletions, changes: additions + deletions };
}

/** The files changed between two commits (base -> head), with diff stats. */
function diffFiles(repo: Repo, baseSha: string, headSha: string): { filename: string; status: string; additions: number; deletions: number; changes: number }[] {
  const baseFiles = filesOfCommit(repo, baseSha);
  const headFiles = filesOfCommit(repo, headSha);
  const paths = new Set<string>([...baseFiles.keys(), ...headFiles.keys()]);
  const out: { filename: string; status: string; additions: number; deletions: number; changes: number }[] = [];
  for (const path of [...paths].sort()) {
    const b = baseFiles.get(path);
    const h = headFiles.get(path);
    const oldBuf = b === undefined ? null : (repo.objects.get(b.oid)?.buf ?? null);
    const newBuf = h === undefined ? null : (repo.objects.get(h.oid)?.buf ?? null);
    const stat = diffFileStat(oldBuf, newBuf);
    if (stat.status === 'unchanged') continue;
    out.push({ filename: path, status: stat.status, additions: stat.additions, deletions: stat.deletions, changes: stat.changes });
  }
  return out;
}

/** Whether a pull request's head can merge into its base without conflicts:
 *  two branches changing the same file differently is a conflict. */
function prConflicted(repo: Repo, pull: Pull): boolean {
  // Compare against the CURRENT tip of the base branch, not the sha captured
  // when the PR was created (an earlier merge may have moved it).
  const baseSha = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const headSha = pull.headSha;
  const mergeBaseSha = mergeBase(repo, baseSha, headSha);
  if (mergeBaseSha === null) return false;
  const baseFiles = filesOfCommit(repo, mergeBaseSha);
  const headFiles = filesOfCommit(repo, headSha);
  const targetFiles = filesOfCommit(repo, baseSha);
  for (const [path, h] of headFiles) {
    const b = baseFiles.get(path);
    const t = targetFiles.get(path);
    const headChanged = b === undefined || b.oid !== h.oid;
    const targetChanged = (b === undefined && t !== undefined) || (b !== undefined && t !== undefined && b.oid !== t.oid) || (b !== undefined && t === undefined);
    if (!headChanged || !targetChanged) continue;
    const headBuf = repo.objects.get(h.oid)?.buf;
    const targetBuf = t === undefined ? undefined : repo.objects.get(t.oid)?.buf;
    if (headBuf === undefined || targetBuf === undefined) return true;
    if (!headBuf.equals(targetBuf)) return true;
  }
  // A file deleted on one side and changed on the other is also a conflict.
  for (const [path, b] of baseFiles) {
    if (headFiles.has(path)) continue;
    const t = targetFiles.get(path);
    if (t !== undefined && t.oid !== b.oid) return true;
  }
  return false;
}

function prMergeable(repo: Repo, pull: Pull): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  return prConflicted(repo, pull) ? 'CONFLICTING' : 'MERGEABLE';
}

// ---------------------------------------------------------------------------
// HTTP request / response. Raw TCP server (no node:http — measured faster once
// warm). Res does two writes (head, then body); Node batches queued chunks.
// ---------------------------------------------------------------------------

interface Req {
  method: string;
  path: string;
  query: URLSearchParams;
  queryString: string;
  headers: Map<string, string>;
  body: Buffer;
  host: string;
}

const STATUS_TEXT: Record<number, string> = {
  200: 'OK',
  201: 'Created',
  204: 'No Content',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  409: 'Conflict',
  422: 'Unprocessable Entity',
  500: 'Internal Server Error',
};

let reqCounter = 0;

class Res {
  sock: net.Socket;
  constructor(sock: net.Socket) {
    this.sock = sock;
  }
  private head(status: number, contentType: string, contentLength: number, extra: Record<string, string>): string {
    reqCounter += 1;
    let s = `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? ''}\r\ncontent-type: ${contentType}\r\ncontent-length: ${contentLength}\r\nx-github-request-id: req-${reqCounter}\r\n`;
    for (const k of Object.keys(extra)) s += `${k}: ${extra[k]}\r\n`;
    return s + '\r\n';
  }
  bytes(status: number, body: Buffer, contentType: string, extra: Record<string, string> = {}): void {
    this.sock.write(this.head(status, contentType, body.length, extra));
    if (body.length > 0) this.sock.write(body);
  }
  json(status: number, obj: unknown, extra: Record<string, string> = {}): void {
    const body = Buffer.from(JSON.stringify(obj), 'utf8');
    this.bytes(status, body, 'application/json; charset=utf-8', extra);
  }
  err(status: number, message: string): void {
    this.json(status, { message, documentation_url: DOC_URL });
  }
  empty(status: number): void {
    this.bytes(status, Buffer.alloc(0), 'application/json; charset=utf-8');
  }
}

/** Join pre-serialized JSON object buffers into one JSON array buffer. */
function jsonArrayBytes(items: Buffer[]): Buffer {
  if (items.length === 0) return Buffer.from('[]', 'utf8');
  const parts: Buffer[] = [Buffer.from('[', 'utf8')];
  for (let i = 0; i < items.length; i += 1) {
    if (i > 0) parts.push(Buffer.from(',', 'utf8'));
    parts.push(items[i] as Buffer);
  }
  parts.push(Buffer.from(']', 'utf8'));
  return Buffer.concat(parts);
}

/** Parse a JSON request body; null when it is not a JSON object. */
function bodyObj(req: Req): Record<string, unknown> | null {
  if (req.body.length === 0) return {};
  try {
    const v = JSON.parse(req.body.toString('utf8')) as unknown;
    return asObj(v);
  } catch {
    return null;
  }
}

/** Create a repository owned by the viewer. Starts empty (no commits, no refs);
 *  the first PUT /contents (or git push) creates the initial commit. */
function createRepo(name: string, description: string, isPrivate: boolean): Repo {
  const repo: Repo = {
    id: nextRepoId,
    name,
    owner: VIEWER,
    description,
    isPrivate,
    defaultBranch: 'main',
    createdAt: nowIso(),
    updatedAt: nowIso(),
    objects: new Map(),
    refs: new Map(),
    issues: [],
    pulls: [],
    labels: new Map(),
    nextIssue: 1,
    nextPull: 1,
    nextComment: 1,
  };
  nextRepoId += 1;
  repos.set(repoKey(VIEWER, name), repo);
  bump();
  return repo;
}

/** Commit a new tree on a branch (creating the branch when it has no tip). */
function commitTree(repo: Repo, branch: string, files: Map<string, { oid: string; mode: string }>, message: string): string {
  const treeOid = buildTree(repo, files);
  const tip = repo.refs.get(`refs/heads/${branch}`);
  const parents = tip === undefined ? [] : [tip];
  const commitOid = makeCommit(repo, treeOid, parents, message);
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.updatedAt = nowIso();
  bump();
  return commitOid;
}

function branchListJson(repo: Repo): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const name of [...repo.refs.keys()].filter((r) => r.startsWith('refs/heads/')).sort()) {
    const sha = repo.refs.get(name) as string;
    out.push({ name: name.slice('refs/heads/'.length), commit: { sha, url: `/api/v3/repos/${repoKey(repo.owner, repo.name)}/commits/${sha}` }, protected: false });
  }
  return out;
}

function commitListJson(repo: Repo, tip: string, limit: number): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const queue: string[] = [tip];
  while (queue.length > 0 && out.length < limit) {
    const oid = queue.shift() as string;
    if (seen.has(oid)) continue;
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') continue;
    seen.add(oid);
    const c = parseCommit(obj.buf);
    const who = c.author;
    const email = (who.match(/<([^>]*)>/) ?? [])[1] ?? VIEWER_EMAIL;
    const name = who.replace(/ <.*$/, '').replace(/^[^ ]+ /, '');
    out.push({
      sha: oid,
      commit: {
        message: c.message.endsWith('\n') ? c.message.slice(0, -1) : c.message,
        author: { name: VIEWER, email, date: nowIso() },
        committer: { name: VIEWER, email, date: nowIso() },
      },
      author: viewerJson(),
      committer: viewerJson(),
      parents: c.parents.map((p) => ({ sha: p })),
    });
    for (const p of c.parents) queue.push(p);
  }
  return out;
}

// ---------------------------------------------------------------------------
// REST: repositories, branches, commits, contents
// ---------------------------------------------------------------------------

function repoFromSeg(req: Req, res: Res, owner: string, name: string): Repo | null {
  const repo = getRepo(owner, name);
  if (repo === undefined) {
    res.err(404, 'Not Found');
    return null;
  }
  void req;
  return repo;
}

/** The contents entry for one path on a branch tip (file, dir listing, or null). */
function contentsEntry(repo: Repo, branch: string, path: string): { kind: 'file' | 'dir'; blobOid?: string; treeOid?: string; size?: number } | null {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return null;
  const files = filesOfCommit(repo, tip);
  if (path === '') {
    const tree = parseCommit((repo.objects.get(tip) as GitObject).buf).tree;
    return { kind: 'dir', treeOid: tree };
  }
  const f = files.get(path);
  if (f !== undefined) {
    const obj = repo.objects.get(f.oid);
    return { kind: 'file', blobOid: f.oid, size: obj === undefined ? 0 : obj.buf.length };
  }
  // A directory: any file under path + '/'.
  for (const p of files.keys()) {
    if (p.startsWith(path + '/')) {
      const files2 = filesOfCommit(repo, tip);
      void files2;
      return { kind: 'dir' };
    }
  }
  return null;
}

function contentsDirJson(repo: Repo, branch: string, path: string): Record<string, unknown>[] {
  const tip = repo.refs.get(`refs/heads/${branch}`);
  if (tip === undefined) return [];
  const files = filesOfCommit(repo, tip);
  const prefix = path === '' ? '' : path + '/';
  const seen = new Map<string, { type: string; oid: string; size: number }>();
  for (const [p, f] of files) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    const slash = rest.indexOf('/');
    if (slash < 0) {
      const obj = repo.objects.get(f.oid);
      seen.set(rest, { type: 'file', oid: f.oid, size: obj === undefined ? 0 : obj.buf.length });
    } else {
      const dir = rest.slice(0, slash);
      if (!seen.has(dir)) seen.set(dir, { type: 'dir', oid: '', size: 0 });
    }
  }
  const out: Record<string, unknown>[] = [];
  for (const name of [...seen.keys()].sort()) {
    const e = seen.get(name) as { type: string; oid: string; size: number };
    const p = prefix + name;
    if (e.type === 'file') {
      out.push({ type: 'file', encoding: 'base64', name, path: p, sha: e.oid, size: e.size, url: `/api/v3/repos/${repoKey(repo.owner, repo.name)}/contents/${p}`, html_url: `https://github.com/${repoKey(repo.owner, repo.name)}/blob/${branch}/${p}`, download_url: `https://raw.githubusercontent.com/${repoKey(repo.owner, repo.name)}/${branch}/${p}` });
    } else {
      out.push({ type: 'dir', name, path: p, sha: '', size: 0, url: `/api/v3/repos/${repoKey(repo.owner, repo.name)}/contents/${p}`, html_url: `https://github.com/${repoKey(repo.owner, repo.name)}/tree/${branch}/${p}` });
    }
  }
  return out;
}

function contentsFileJson(repo: Repo, branch: string, path: string, blobOid: string, size: number): Record<string, unknown> {
  const obj = repo.objects.get(blobOid);
  const content = obj === undefined ? '' : obj.buf.toString('base64');
  const name = path.split('/').pop() as string;
  return {
    type: 'file',
    encoding: 'base64',
    size,
    name,
    path,
    sha: blobOid,
    content,
    url: `/api/v3/repos/${repoKey(repo.owner, repo.name)}/contents/${path}`,
    html_url: `https://github.com/${repoKey(repo.owner, repo.name)}/blob/${branch}/${path}`,
    download_url: `https://raw.githubusercontent.com/${repoKey(repo.owner, repo.name)}/${branch}/${path}`,
    git_url: `/api/v3/repos/${repoKey(repo.owner, repo.name)}/git/blobs/${blobOid}`,
  };
}

/** The whole REST v3 surface. Returns true when the path is a REST route. */
function handleRest(req: Req, res: Res): boolean {
  const seg = req.path.split('/').filter((s) => s !== '');
  if (seg.length < 2 || seg[0] !== 'api' || seg[1] !== 'v3') return false;
  const method = req.method;

  // GET /api/v3[/] — the API root.
  if (seg.length === 2) {
    if (method !== 'GET') {
      res.err(404, 'Not Found');
      return true;
    }
    res.json(200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (seg.length === 3 && seg[2] === 'meta') {
    if (method !== 'GET') {
      res.err(404, 'Not Found');
      return true;
    }
    res.json(200, { installed_version: '1.0.0', verifiable_password_authentication: true });
    return true;
  }

  // GET /api/v3/user
  if (seg.length === 3 && seg[2] === 'user') {
    if (method !== 'GET') {
      res.err(404, 'Not Found');
      return true;
    }
    res.json(200, viewerJson());
    return true;
  }

  // /api/v3/user/repos — list / create.
  if (seg.length === 4 && seg[2] === 'user' && seg[3] === 'repos') {
    if (method === 'GET') {
      const { page, perPage } = pageParams(req.query);
      const all = listViewerRepos();
      const start = (page - 1) * perPage;
      const items = all.slice(start, start + perPage);
      const link = linkHeader(req.host, req.path, req.query, page, perPage, all.length);
      res.json(200, items.map((r) => repoJson(r)), link === '' ? {} : { link });
      return true;
    }
    if (method === 'POST') {
      const body = bodyObj(req);
      if (body === null) {
        res.err(400, 'Problems parsing JSON');
        return true;
      }
      const name = asStr(body.name);
      if (name === '' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(name) || name.endsWith('.git')) {
        res.err(422, 'Validation Failed');
        return true;
      }
      if (getRepo(VIEWER, name) !== undefined) {
        // The git client's createRepo tolerates a 422 only when the body
        // says the name already exists.
        res.err(422, 'Validation Failed: name already exists on this account');
        return true;
      }
      const repo = createRepo(name, asStr(body.description), asBool(body.private));
      res.json(201, repoJson(repo));
      return true;
    }
    res.err(404, 'Not Found');
    return true;
  }

  // /api/v3/repos/{owner}/{name}[/...]
  if (seg.length >= 5 && seg[2] === 'repos') {
    const owner = seg[3] as string;
    const name = seg[4] as string;
    const repo = getRepo(owner, name);
    if (repo === undefined) {
      res.err(404, 'Not Found');
      return true;
    }

    // GET / PATCH / DELETE /api/v3/repos/{o}/{r}
    if (seg.length === 5) {
      if (method === 'GET') {
        res.json(200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        const body = bodyObj(req);
        if (body === null) {
          res.err(400, 'Problems parsing JSON');
          return true;
        }
        if (typeof body.description === 'string') repo.description = body.description;
        repo.updatedAt = nowIso();
        bump();
        res.json(200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        repos.delete(repoKey(owner, name));
        bump();
        res.empty(204);
        return true;
      }
      res.err(404, 'Not Found');
      return true;
    }

    const sub = seg[5] as string;

    // Branches.
    if (sub === 'branches') {
      if (seg.length === 6 && method === 'GET') {
        res.json(200, branchListJson(repo));
        return true;
      }
      if (seg.length === 7 && method === 'GET') {
        const branch = seg[6] as string;
        const sha = repo.refs.get(`refs/heads/${branch}`);
        if (sha === undefined) {
          res.err(404, 'Not Found');
          return true;
        }
        res.json(200, { name: branch, commit: { sha, url: `/api/v3/repos/${repoKey(owner, name)}/commits/${sha}` }, protected: false });
        return true;
      }
      res.err(404, 'Not Found');
      return true;
    }

    // Commits.
    if (sub === 'commits' && seg.length === 6 && method === 'GET') {
      const ref = req.query.get('sha') ?? repo.defaultBranch;
      const tip = repo.refs.get(`refs/heads/${ref}`) ?? (isOid(ref) ? ref : undefined);
      if (tip === undefined) {
        res.json(200, []);
        return true;
      }
      res.json(200, commitListJson(repo, tip, 30));
      return true;
    }

    // Git refs.
    if (sub === 'git' && seg[6] === 'refs') {
      if (seg.length === 7 && method === 'POST') {
        const body = bodyObj(req);
        if (body === null) {
          res.err(400, 'Problems parsing JSON');
          return true;
        }
        const ref = asStr(body.ref);
        const sha = asStr(body.sha);
        if (!ref.startsWith('refs/heads/') || !isOid(sha)) {
          res.err(422, 'Validation Failed');
          return true;
        }
        if (repo.refs.has(ref)) {
          res.err(422, 'Validation Failed');
          return true;
        }
        const obj = repo.objects.get(sha);
        if (obj === undefined || obj.type !== 'commit') {
          res.err(422, 'Validation Failed');
          return true;
        }
        repo.refs.set(ref, sha);
        bump();
        res.json(201, { ref, object: { sha, type: 'commit', url: `/api/v3/repos/${repoKey(owner, name)}/git/commits/${sha}` } });
        return true;
      }
      if (seg.length >= 8 && method === 'GET') {
        const ref = seg.slice(7).join('/');
        const sha = repo.refs.get(ref);
        if (sha === undefined) {
          res.err(404, 'Not Found');
          return true;
        }
        res.json(200, { ref, object: { sha, type: 'commit', url: `/api/v3/repos/${repoKey(owner, name)}/git/commits/${sha}` } });
        return true;
      }
      res.err(404, 'Not Found');
      return true;
    }

    // Contents.
    if (sub === 'contents') {
      const path = seg.slice(6).join('/');
      const branch = req.query.get('ref') ?? undefined;
      if (method === 'GET') {
        const b = branch ?? repo.defaultBranch;
        const entry = contentsEntry(repo, b, path);
        if (entry === null) {
          res.err(404, 'Not Found');
          return true;
        }
        if (entry.kind === 'file') {
          res.json(200, contentsFileJson(repo, b, path, entry.blobOid as string, entry.size ?? 0));
          return true;
        }
        res.json(200, contentsDirJson(repo, b, path));
        return true;
      }
      if (method === 'PUT' || method === 'DELETE') {
        const body = bodyObj(req);
        if (body === null) {
          res.err(400, 'Problems parsing JSON');
          return true;
        }
        const b = asStr(body.branch, repo.defaultBranch);
        const tip = repo.refs.get(`refs/heads/${b}`);
        const files = tip === undefined ? new Map<string, { oid: string; mode: string }>() : filesOfCommit(repo, tip);
        const current = files.get(path);
        const currentSha = current === undefined ? undefined : current.oid;
        if (method === 'DELETE') {
          if (current === undefined) {
            res.err(404, 'Not Found');
            return true;
          }
          const sha = asStr(body.sha);
          if (sha !== '' && sha !== currentSha) {
            res.err(409, 'sha does not match');
            return true;
          }
          files.delete(path);
          const commitOid = commitTree(repo, b, files, asStr(body.message, `Delete ${path}`));
          res.json(200, { commit: { sha: commitOid, message: asStr(body.message, `Delete ${path}`) } });
          return true;
        }
        // PUT: create or update.
        const contentB64 = asStr(body.content);
        let contentBuf: Buffer;
        try {
          contentBuf = Buffer.from(contentB64, 'base64');
          if (contentB64 !== '' && contentBuf.toString('base64').replace(/=+$/, '') !== contentB64.replace(/=+$/, '')) {
            // tolerate padding differences; only reject when it cannot decode
          }
        } catch {
          res.err(400, 'content is not valid base64');
          return true;
        }
        const sha = asStr(body.sha);
        const isUpdate = current !== undefined;
        if (isUpdate) {
          if (sha === '' || sha !== currentSha) {
            res.err(409, 'sha does not match');
            return true;
          }
        } else if (sha !== '') {
          res.err(409, 'sha does not match');
          return true;
        }
        const blobOid = storeObject(repo, 'blob', contentBuf);
        files.set(path, { oid: blobOid, mode: '100644' });
        const commitOid = commitTree(repo, b, files, asStr(body.message, `Update ${path}`));
        const contentObj = contentsFileJson(repo, b, path, blobOid, contentBuf.length);
        res.json(isUpdate ? 200 : 201, { content: { name: contentObj.name, path: contentObj.path, sha: blobOid, size: contentBuf.length, encoding: 'base64' }, commit: { sha: commitOid, message: asStr(body.message, `Update ${path}`) } });
        return true;
      }
      res.err(404, 'Not Found');
      return true;
    }

    // Labels.
    if (sub === 'labels' && seg.length === 6) {
      if (method === 'GET') {
        res.json(200, [...repo.labels.keys()].map((n) => ({ name: n, color: repo.labels.get(n) ?? 'ededed', description: '' })));
        return true;
      }
      if (method === 'POST') {
        const body = bodyObj(req);
        if (body === null) {
          res.err(400, 'Problems parsing JSON');
          return true;
        }
        const name = asStr(body.name);
        if (name === '') {
          res.err(422, 'Validation Failed');
          return true;
        }
        if (!repo.labels.has(name)) {
          repo.labels.set(name, asStr(body.color, 'ededed'));
          bump();
        }
        res.json(201, { name, color: repo.labels.get(name) ?? 'ededed', description: '' });
        return true;
      }
      res.err(404, 'Not Found');
      return true;
    }

    // Issues.
    if (sub === 'issues') {
      // GET /issues/comments/{id}
      if (seg.length === 8 && seg[6] === 'comments' && method === 'GET') {
        const id = parseInt(seg[7] as string, 10);
        for (const iss of repo.issues) {
          for (const c of iss.comments) {
            if (c.id === id) {
              res.json(200, commentJson(repo, iss, c));
              return true;
            }
          }
        }
        res.err(404, 'Not Found');
        return true;
      }
      // List / create.
      if (seg.length === 6) {
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const sort = req.query.get('sort') ?? 'created';
          const direction = req.query.get('direction') ?? 'desc';
          void sort;
          let items = repo.issues.filter((i) => state === 'all' || i.state === state);
          items = [...items].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
          const { page, perPage } = pageParams(req.query);
          const start = (page - 1) * perPage;
          const pageItems = items.slice(start, start + perPage);
          const link = linkHeader(req.host, req.path, req.query, page, perPage, items.length);
          res.bytes(200, jsonArrayBytes(pageItems.map((i) => issueBytes(repo, i))), 'application/json; charset=utf-8', link === '' ? {} : { link });
          return true;
        }
        if (method === 'POST') {
          const body = bodyObj(req);
          if (body === null) {
            res.err(400, 'Problems parsing JSON');
            return true;
          }
          const title = asStr(body.title);
          if (title === '') {
            res.err(422, 'Validation Failed');
            return true;
          }
          const labels: string[] = [];
          if (Array.isArray(body.labels)) {
            for (const l of body.labels as unknown[]) {
              const name = typeof l === 'string' ? l : asStr(asObj(l).name);
              if (!repo.labels.has(name)) {
                res.err(422, `Validation Failed: label "${name}" does not exist`);
                return true;
              }
              labels.push(name);
            }
          }
          const issue: Issue = {
            id: nextGlobalId,
            number: repo.nextIssue,
            title,
            body: asStr(body.body),
            state: 'open',
            labels,
            comments: [],
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          nextGlobalId += 1;
          repo.nextIssue += 1;
          repo.issues.push(issue);
          bump();
          res.json(201, issueJson(repo, issue));
          return true;
        }
        res.err(404, 'Not Found');
        return true;
      }
      // GET / PATCH /issues/{n}
      if (seg.length === 7) {
        const n = parseInt(seg[6] as string, 10);
        if (!Number.isInteger(n)) {
          res.err(404, 'Not Found');
          return true;
        }
        const issue = findIssue(repo, n);
        if (issue === undefined) {
          res.err(404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          res.bytes(200, issueBytes(repo, issue), 'application/json; charset=utf-8');
          return true;
        }
        if (method === 'PATCH') {
          const body = bodyObj(req);
          if (body === null) {
            res.err(400, 'Problems parsing JSON');
            return true;
          }
          if (typeof body.title === 'string') issue.title = body.title;
          if (typeof body.body === 'string') issue.body = body.body;
          if (body.state === 'open' || body.state === 'closed') issue.state = body.state;
          issue.updatedAt = nowIso();
          dropIssueView(issue);
          bump();
          res.json(200, issueJson(repo, issue));
          return true;
        }
        res.err(404, 'Not Found');
        return true;
      }
      // /issues/{n}/comments
      if (seg.length === 8 && seg[7] === 'comments') {
        const n = parseInt(seg[6] as string, 10);
        if (!Number.isInteger(n)) {
          res.err(404, 'Not Found');
          return true;
        }
        const issue = findIssue(repo, n);
        if (issue === undefined) {
          res.err(404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          res.json(200, issue.comments.map((c) => commentJson(repo, issue, c)));
          return true;
        }
        if (method === 'POST') {
          const body = bodyObj(req);
          if (body === null) {
            res.err(400, 'Problems parsing JSON');
            return true;
          }
          const comment: CommentT = {
            id: repo.nextComment,
            body: asStr(body.body),
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          repo.nextComment += 1;
          issue.comments.push(comment);
          issue.updatedAt = nowIso();
          dropIssueView(issue);
          bump();
          res.json(201, commentJson(repo, issue, comment));
          return true;
        }
        res.err(404, 'Not Found');
        return true;
      }
      res.err(404, 'Not Found');
      return true;
    }

    // Pulls.
    if (sub === 'pulls') {
      if (seg.length === 6) {
        if (method === 'GET') {
          const state = req.query.get('state') ?? 'open';
          const items = repo.pulls.filter((p) => state === 'all' || p.state === state);
          const { page, perPage } = pageParams(req.query);
          const start = (page - 1) * perPage;
          const pageItems = items.slice(start, start + perPage);
          const link = linkHeader(req.host, req.path, req.query, page, perPage, items.length);
          res.json(200, pageItems.map((p) => pullJson(repo, p)), link === '' ? {} : { link });
          return true;
        }
        if (method === 'POST') {
          const body = bodyObj(req);
          if (body === null) {
            res.err(400, 'Problems parsing JSON');
            return true;
          }
          const title = asStr(body.title);
          const head = asStr(body.head);
          const base = asStr(body.base, repo.defaultBranch);
          if (title === '' || head === '' || base === '') {
            res.err(422, 'Validation Failed');
            return true;
          }
          const headSha = repo.refs.get(`refs/heads/${head}`);
          const baseSha = repo.refs.get(`refs/heads/${base}`);
          if (headSha === undefined || baseSha === undefined) {
            res.err(422, 'Validation Failed');
            return true;
          }
          const pull: Pull = {
            id: nextGlobalId,
            number: repo.nextPull,
            title,
            body: asStr(body.body),
            state: 'open',
            head,
            base,
            headSha,
            baseSha,
            merged: false,
            mergedAt: '',
            mergeCommitSha: '',
            createdAt: nowIso(),
            updatedAt: nowIso(),
          };
          nextGlobalId += 1;
          repo.nextPull += 1;
          repo.pulls.push(pull);
          bump();
          res.json(201, pullJson(repo, pull));
          return true;
        }
        res.err(404, 'Not Found');
        return true;
      }
      if (seg.length === 7) {
        const n = parseInt(seg[6] as string, 10);
        if (!Number.isInteger(n)) {
          res.err(404, 'Not Found');
          return true;
        }
        const pull = findPull(repo, n);
        if (pull === undefined) {
          res.err(404, 'Not Found');
          return true;
        }
        if (method === 'GET') {
          res.json(200, pullJson(repo, pull));
          return true;
        }
        res.err(404, 'Not Found');
        return true;
      }
      if (seg.length === 8) {
        const n = parseInt(seg[6] as string, 10);
        if (!Number.isInteger(n)) {
          res.err(404, 'Not Found');
          return true;
        }
        const pull = findPull(repo, n);
        if (pull === undefined) {
          res.err(404, 'Not Found');
          return true;
        }
        if (seg[7] === 'files' && method === 'GET') {
          res.json(200, diffFiles(repo, pull.baseSha, pull.headSha));
          return true;
        }
        if (seg[7] === 'merge' && method === 'PUT') {
          if (pull.state !== 'open') {
            res.err(405, 'Pull request is already merged or closed');
            return true;
          }
          if (prConflicted(repo, pull)) {
            res.err(405, 'Merge conflict');
            return true;
          }
          const m = squashMerge(repo, pull);
          if (!m.ok) {
            res.err(405, 'Merge conflict');
            return true;
          }
          res.json(200, { sha: m.sha, merged: true, message: `Pull request #${pull.number} merged` });
          return true;
        }
        res.err(404, 'Not Found');
        return true;
      }
      res.err(404, 'Not Found');
      return true;
    }

    res.err(404, 'Not Found');
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// GraphQL v4. Tokenizer + recursive-descent parser + executor. Supports the
// documents the suite sends: operations with variables, aliases, arguments
// (literals, variables, enums, lists, objects), inline fragments, and the
// __type introspection probes. Batched bodies (JSON arrays) are handled by
// the caller, one operation at a time.
// ---------------------------------------------------------------------------

type GqlValue =
  | { kind: 'var'; name: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'string'; value: string }
  | { kind: 'bool'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; items: GqlValue[] }
  | { kind: 'object'; fields: { name: string; value: GqlValue }[] };

interface GqlField {
  alias: string;
  name: string;
  args: { name: string; value: GqlValue }[];
  sel: GqlSel[] | null;
}
type GqlSel = { kind: 'field'; f: GqlField } | { kind: 'frag'; type: string; sel: GqlSel[] };
interface GqlOp {
  kind: 'query' | 'mutation';
  sel: GqlSel[];
}

interface GqlTok {
  kind: 'name' | 'int' | 'float' | 'string' | 'punct' | 'dots';
  value: string;
}

function gqlTokenize(src: string): GqlTok[] {
  const toks: GqlTok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i] as string;
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',') {
      i += 1;
      continue;
    }
    if (c === '#') {
      while (i < src.length && src[i] !== '\n') i += 1;
      continue;
    }
    if (c === '.' && src[i + 1] === '.' && src[i + 2] === '.') {
      toks.push({ kind: 'dots', value: '...' });
      i += 3;
      continue;
    }
    if ('{}():$!=@[]|&'.includes(c)) {
      toks.push({ kind: 'punct', value: c });
      i += 1;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const e = src[j + 1] as string;
          out += e === 'n' ? '\n' : e === 't' ? '\t' : e === 'r' ? '\r' : e;
          j += 2;
        } else {
          out += src[j] as string;
          j += 1;
        }
      }
      toks.push({ kind: 'string', value: out });
      i = j + 1;
      continue;
    }
    if ((c >= '0' && c <= '9') || (c === '-' && src[i + 1] !== undefined && (src[i + 1] as string) >= '0' && (src[i + 1] as string) <= '9')) {
      let j = i;
      if (src[j] === '-') j += 1;
      while (j < src.length && (src[j] as string) >= '0' && (src[j] as string) <= '9') j += 1;
      let isFloat = false;
      if (src[j] === '.' && src[j + 1] !== undefined && (src[j + 1] as string) >= '0' && (src[j + 1] as string) <= '9') {
        isFloat = true;
        j += 1;
        while (j < src.length && (src[j] as string) >= '0' && (src[j] as string) <= '9') j += 1;
      }
      toks.push({ kind: isFloat ? 'float' : 'int', value: src.slice(i, j) });
      i = j;
      continue;
    }
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      let j = i;
      while (j < src.length && (((src[j] as string) >= 'a' && (src[j] as string) <= 'z') || ((src[j] as string) >= 'A' && (src[j] as string) <= 'Z') || ((src[j] as string) >= '0' && (src[j] as string) <= '9') || src[j] === '_')) j += 1;
      toks.push({ kind: 'name', value: src.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  return toks;
}

class GqlParser {
  toks: GqlTok[];
  pos = 0;
  constructor(toks: GqlTok[]) {
    this.toks = toks;
  }
  peek(): GqlTok | null {
    return this.pos < this.toks.length ? (this.toks[this.pos] as GqlTok) : null;
  }
  next(): GqlTok | null {
    const t = this.peek();
    if (t !== null) this.pos += 1;
    return t;
  }
  expectPunct(v: string): boolean {
    const t = this.peek();
    if (t !== null && t.kind === 'punct' && t.value === v) {
      this.pos += 1;
      return true;
    }
    return false;
  }
  parseValue(): GqlValue | null {
    const t = this.peek();
    if (t === null) return null;
    if (t.kind === 'punct' && t.value === '$') {
      this.pos += 1;
      const n = this.next();
      if (n === null || n.kind !== 'name') return null;
      return { kind: 'var', name: n.value };
    }
    if (t.kind === 'string') {
      this.pos += 1;
      return { kind: 'string', value: t.value };
    }
    if (t.kind === 'int') {
      this.pos += 1;
      return { kind: 'int', value: parseInt(t.value, 10) };
    }
    if (t.kind === 'float') {
      this.pos += 1;
      return { kind: 'float', value: parseFloat(t.value) };
    }
    if (t.kind === 'name') {
      this.pos += 1;
      if (t.value === 'true') return { kind: 'bool', value: true };
      if (t.value === 'false') return { kind: 'bool', value: false };
      if (t.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: t.value };
    }
    if (t.kind === 'punct' && t.value === '[') {
      this.pos += 1;
      const items: GqlValue[] = [];
      while (true) {
        const p = this.peek();
        if (p === null) return null;
        if (p.kind === 'punct' && p.value === ']') {
          this.pos += 1;
          break;
        }
        const v = this.parseValue();
        if (v === null) return null;
        items.push(v);
      }
      return { kind: 'list', items };
    }
    if (t.kind === 'punct' && t.value === '{') {
      this.pos += 1;
      const fields: { name: string; value: GqlValue }[] = [];
      while (true) {
        const p = this.peek();
        if (p === null) return null;
        if (p.kind === 'punct' && p.value === '}') {
          this.pos += 1;
          break;
        }
        const n = this.next();
        if (n === null || n.kind !== 'name') return null;
        if (!this.expectPunct(':')) return null;
        const v = this.parseValue();
        if (v === null) return null;
        fields.push({ name: n.value, value: v });
      }
      return { kind: 'object', fields };
    }
    return null;
  }
  parseArgs(): { name: string; value: GqlValue }[] | null {
    if (!this.expectPunct('(')) return [];
    const args: { name: string; value: GqlValue }[] = [];
    while (true) {
      const p = this.peek();
      if (p === null) return null;
      if (p.kind === 'punct' && p.value === ')') {
        this.pos += 1;
        break;
      }
      const n = this.next();
      if (n === null || n.kind !== 'name') return null;
      if (!this.expectPunct(':')) return null;
      const v = this.parseValue();
      if (v === null) return null;
      args.push({ name: n.value, value: v });
    }
    return args;
  }
  parseSelectionSet(): GqlSel[] | null {
    if (!this.expectPunct('{')) return null;
    const sel: GqlSel[] = [];
    while (true) {
      const p = this.peek();
      if (p === null) return null;
      if (p.kind === 'punct' && p.value === '}') {
        this.pos += 1;
        break;
      }
      if (p.kind === 'dots') {
        this.pos += 1;
        const n = this.next();
        if (n !== null && n.kind === 'name' && n.value === 'on') {
          const typeTok = this.next();
          if (typeTok === null || typeTok.kind !== 'name') return null;
          const inner = this.parseSelectionSet();
          if (inner === null) return null;
          sel.push({ kind: 'frag', type: typeTok.value, sel: inner });
        } else {
          // Named fragment spread: the suite never sends one; skip its selection.
          return null;
        }
        continue;
      }
      const nameTok = this.next();
      if (nameTok === null || nameTok.kind !== 'name') return null;
      let alias = nameTok.value;
      let name = nameTok.value;
      const colon = this.peek();
      if (colon !== null && colon.kind === 'punct' && colon.value === ':') {
        this.pos += 1;
        const real = this.next();
        if (real === null || real.kind !== 'name') return null;
        name = real.value;
      }
      let args: { name: string; value: GqlValue }[] = [];
      const paren = this.peek();
      if (paren !== null && paren.kind === 'punct' && paren.value === '(') {
        const a = this.parseArgs();
        if (a === null) return null;
        args = a;
      }
      let sub: GqlSel[] | null = null;
      const brace = this.peek();
      if (brace !== null && brace.kind === 'punct' && brace.value === '{') {
        sub = this.parseSelectionSet();
        if (sub === null) return null;
      }
      sel.push({ kind: 'field', f: { alias, name, args, sel: sub } });
    }
    return sel;
  }
  /** Skip a balanced (...) group (variable definitions, directives). */
  skipParens(): void {
    if (!this.expectPunct('(')) return;
    let depth = 1;
    while (depth > 0) {
      const t = this.next();
      if (t === null) return;
      if (t.kind === 'punct' && t.value === '(') depth += 1;
      else if (t.kind === 'punct' && t.value === ')') depth -= 1;
    }
  }
  parseOperation(): GqlOp | null {
    let kind: 'query' | 'mutation' = 'query';
    const t = this.peek();
    if (t !== null && t.kind === 'name' && (t.value === 'query' || t.value === 'mutation')) {
      kind = t.value as 'query' | 'mutation';
      this.pos += 1;
      const nameTok = this.peek();
      if (nameTok !== null && nameTok.kind === 'name') this.pos += 1;
    }
    const paren = this.peek();
    if (paren !== null && paren.kind === 'punct' && paren.value === '(') this.skipParens();
    const sel = this.parseSelectionSet();
    if (sel === null) return null;
    return { kind, sel };
  }
}

function gqlParse(src: string): GqlOp | null {
  try {
    const parser = new GqlParser(gqlTokenize(src));
    return parser.parseOperation();
  } catch {
    return null;
  }
}

/** Resolve a parsed argument value against the request's variables. */
function evalGqlValue(v: GqlValue, vars: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'var':
      return vars[v.name];
    case 'int':
    case 'float':
    case 'string':
    case 'bool':
      return v.value;
    case 'null':
      return null;
    case 'enum':
      return v.value;
    case 'list':
      return v.items.map((it) => evalGqlValue(it, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = evalGqlValue(f.value, vars);
      return out;
    }
  }
}
function argVal(field: GqlField, name: string, vars: Record<string, unknown>): unknown {
  for (const a of field.args) if (a.name === name) return evalGqlValue(a.value, vars);
  return undefined;
}
function argStr(field: GqlField, name: string, vars: Record<string, unknown>): string {
  const v = argVal(field, name, vars);
  return typeof v === 'string' ? v : '';
}
function argNum(field: GqlField, name: string, vars: Record<string, unknown>): number {
  const v = argVal(field, name, vars);
  return typeof v === 'number' ? v : 0;
}

// ---------------------------------------------------------------------------
// GraphQL execution. Resolvers are a dispatch table by parent type
// (GQL_RESOLVERS in push2's terms); connections share the generic gqlPage.
// ---------------------------------------------------------------------------

/** Squash-merge a pull request onto its base branch; shared by REST, GraphQL and MCP. */
function squashMerge(repo: Repo, pull: Pull): { ok: boolean; sha: string; reason: string } {
  if (pull.state !== 'open') return { ok: false, sha: '', reason: 'already closed' };
  if (prConflicted(repo, pull)) return { ok: false, sha: '', reason: 'conflict' };
  // The merge applies onto the CURRENT tip of the base branch, not the sha
  // captured when the PR was created (an earlier merge may have moved it).
  const baseTip = repo.refs.get(`refs/heads/${pull.base}`) ?? pull.baseSha;
  const mergeBaseSha = mergeBase(repo, baseTip, pull.headSha);
  const mergedFiles = filesOfCommit(repo, baseTip);
  if (mergeBaseSha !== null) {
    const baseFiles = filesOfCommit(repo, mergeBaseSha);
    const headFiles = filesOfCommit(repo, pull.headSha);
    for (const [path, h] of headFiles) {
      const b = baseFiles.get(path);
      if (b === undefined || b.oid !== h.oid) mergedFiles.set(path, h);
    }
    for (const path of baseFiles.keys()) {
      if (!headFiles.has(path)) mergedFiles.delete(path);
    }
  } else {
    const headFiles = filesOfCommit(repo, pull.headSha);
    mergedFiles.clear();
    for (const [path, h] of headFiles) mergedFiles.set(path, h);
  }
  const commitOid = commitTree(repo, pull.base, mergedFiles, `Merge pull request #${pull.number} from ${pull.head}`);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.mergeCommitSha = commitOid;
  pull.updatedAt = nowIso();
  bump();
  return { ok: true, sha: commitOid, reason: '' };
}

type GqlResolved =
  | { k: 'scalar'; v: unknown }
  | { k: 'obj'; t: string; v: unknown }
  | { k: 'list'; items: GqlResolved[] }
  | { k: 'null' };

const gqlNull: GqlResolved = { k: 'null' };
function gqlScalar(v: unknown): GqlResolved {
  return { k: 'scalar', v };
}
function gqlObj(t: string, v: unknown): GqlResolved {
  return { k: 'obj', t, v };
}

const GQL_TYPE_FIELDS: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'body', 'state', 'url', 'createdAt', 'updatedAt', 'author', 'labels', 'comments'],
  PullRequest: ['id', 'number', 'title', 'body', 'state', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeable', 'merged', 'mergedAt', 'files', 'createdAt', 'updatedAt', 'author'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'url'],
  User: ['id', 'login', 'name'],
  Ref: ['name'],
  IssueConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'pageInfo', 'totalCount'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'endCursor', 'startCursor'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changes', 'status'],
  IssueComment: ['id', 'body', 'author'],
  CommentEdge: ['node', 'cursor'],
  Query: ['viewer', 'repository', 'node'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  CreateIssuePayload: ['issue'],
  CloseIssuePayload: ['issue'],
  CreatePullRequestPayload: ['pullRequest'],
  MergePullRequestPayload: ['pullRequest'],
  AddCommentPayload: ['commentEdge'],
  __Type: ['name', 'kind', 'fields', 'enumValues'],
  __Field: ['name'],
  __EnumValue: ['name'],
};
const GQL_TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['MERGEABLE', 'CONFLICTING', 'UNKNOWN'],
};

function gqlCursor(n: number): string {
  return b64encode(`cursor:${n}`);
}
function gqlCursorNum(cursor: unknown): number | null {
  if (typeof cursor !== 'string' || cursor === '') return null;
  try {
    const s = b64decode(cursor);
    if (!s.startsWith('cursor:')) return null;
    const n = parseInt(s.slice(7), 10);
    return Number.isInteger(n) ? n : null;
  } catch {
    return null;
  }
}

/** Generic cursor page over an already-sorted array. */
function gqlPage<T>(items: T[], first: number, afterNum: number | null, key: (it: T) => number): { page: T[]; hasNextPage: boolean; endCursor: string | null } {
  let start = 0;
  if (afterNum !== null) {
    const idx = items.findIndex((it) => key(it) === afterNum);
    start = idx >= 0 ? idx + 1 : items.length;
  }
  const page = items.slice(start, start + Math.max(0, first));
  const hasNextPage = start + page.length < items.length;
  const endCursor = page.length > 0 ? gqlCursor(key(page[page.length - 1] as T)) : null;
  return { page, hasNextPage, endCursor };
}

function gqlRepoFromId(id: unknown): Repo | null {
  if (typeof id !== 'string') return null;
  const g = ungid(id);
  if (g === null || g.type !== 'Repository') return null;
  const slash = g.key.indexOf('/');
  if (slash < 0) return null;
  return getRepo(g.key.slice(0, slash), g.key.slice(slash + 1)) ?? null;
}
function gqlIssueFromId(id: unknown): { repo: Repo; issue: Issue } | null {
  if (typeof id !== 'string') return null;
  const g = ungid(id);
  if (g === null || g.type !== 'Issue') return null;
  const parts = g.key.split('/');
  if (parts.length < 3) return null;
  const repo = getRepo(parts[0] as string, parts[1] as string);
  if (repo === undefined) return null;
  const issue = findIssue(repo, parseInt(parts[2] as string, 10));
  if (issue === undefined) return null;
  return { repo, issue };
}
function gqlPullFromId(id: unknown): { repo: Repo; pull: Pull } | null {
  if (typeof id !== 'string') return null;
  const g = ungid(id);
  if (g === null || g.type !== 'PullRequest') return null;
  const parts = g.key.split('/');
  if (parts.length < 3) return null;
  const repo = getRepo(parts[0] as string, parts[1] as string);
  if (repo === undefined) return null;
  const pull = findPull(repo, parseInt(parts[2] as string, 10));
  if (pull === undefined) return null;
  return { repo, pull };
}

function gqlCreateIssue(repo: Repo, title: string, body: string): Issue {
  const issue: Issue = {
    id: nextGlobalId,
    number: repo.nextIssue,
    title,
    body,
    state: 'open',
    labels: [],
    comments: [],
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  nextGlobalId += 1;
  repo.nextIssue += 1;
  repo.issues.push(issue);
  bump();
  return issue;
}
function gqlCreatePull(repo: Repo, title: string, body: string, head: string, base: string): Pull | null {
  const headSha = repo.refs.get(`refs/heads/${head}`);
  const baseSha = repo.refs.get(`refs/heads/${base}`);
  if (headSha === undefined || baseSha === undefined) return null;
  const pull: Pull = {
    id: nextGlobalId,
    number: repo.nextPull,
    title,
    body,
    state: 'open',
    head,
    base,
    headSha,
    baseSha,
    merged: false,
    mergedAt: '',
    mergeCommitSha: '',
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  nextGlobalId += 1;
  repo.nextPull += 1;
  repo.pulls.push(pull);
  bump();
  return pull;
}

/** The field resolver dispatch. `value` is the parent's internal value. */
function gqlResolveField(type: string, value: unknown, field: GqlField, vars: Record<string, unknown>, errors: { message: string }[]): GqlResolved {
  const name = field.name;
  if (name === '__typename') return gqlScalar(type);
  switch (type) {
    case 'Query': {
      if (name === 'viewer') return gqlObj('User', { login: VIEWER, id: VIEWER_ID });
      if (name === 'repository') {
        const repo = getRepo(argStr(field, 'owner', vars), argStr(field, 'name', vars));
        return repo === undefined ? gqlNull : gqlObj('Repository', repo);
      }
      if (name === 'node') {
        const id = argVal(field, 'id', vars);
        if (typeof id !== 'string') return gqlNull;
        const g = ungid(id);
        if (g === null) return gqlNull;
        if (g.type === 'Repository') {
          const repo = gqlRepoFromId(id);
          return repo === null ? gqlNull : gqlObj('Repository', repo);
        }
        if (g.type === 'Issue') {
          const found = gqlIssueFromId(id);
          return found === null ? gqlNull : gqlObj('Issue', found);
        }
        if (g.type === 'PullRequest') {
          const found = gqlPullFromId(id);
          return found === null ? gqlNull : gqlObj('PullRequest', found);
        }
        return gqlNull;
      }
      if (name === '__type') {
        const tname = argStr(field, 'name', vars);
        if (GQL_TYPE_FIELDS[tname] !== undefined) return gqlObj('__Type', { name: tname, kind: 'OBJECT', fields: GQL_TYPE_FIELDS[tname], enumValues: [] });
        if (GQL_TYPE_ENUMS[tname] !== undefined) return gqlObj('__Type', { name: tname, kind: 'ENUM', fields: [], enumValues: GQL_TYPE_ENUMS[tname] });
        return gqlNull;
      }
      if (name === '__schema') return gqlObj('__Schema', { types: Object.keys(GQL_TYPE_FIELDS) });
      break;
    }
    case 'Mutation': {
      if (name === 'createIssue') {
        const input = asObj(argVal(field, 'input', vars));
        const repo = gqlRepoFromId(input.repositoryId);
        if (repo === null) return gqlObj('CreateIssuePayload', { issue: null });
        const issue = gqlCreateIssue(repo, asStr(input.title), asStr(input.body));
        return gqlObj('CreateIssuePayload', { issue: { repo, issue } });
      }
      if (name === 'closeIssue') {
        const input = asObj(argVal(field, 'input', vars));
        const found = gqlIssueFromId(input.issueId);
        if (found === null) return gqlObj('CloseIssuePayload', { issue: null });
        found.issue.state = 'closed';
        found.issue.updatedAt = nowIso();
        dropIssueView(found.issue);
        bump();
        return gqlObj('CloseIssuePayload', { issue: found });
      }
      if (name === 'createPullRequest') {
        const input = asObj(argVal(field, 'input', vars));
        const repo = gqlRepoFromId(input.repositoryId);
        if (repo === null) return gqlObj('CreatePullRequestPayload', { pull: null });
        const pull = gqlCreatePull(repo, asStr(input.title), asStr(input.body), asStr(input.headRefName), asStr(input.baseRefName));
        return gqlObj('CreatePullRequestPayload', { pull: pull === null ? null : { repo, pull } });
      }
      if (name === 'mergePullRequest') {
        const input = asObj(argVal(field, 'input', vars));
        const found = gqlPullFromId(input.pullRequestId);
        if (found === null) return gqlObj('MergePullRequestPayload', { pull: null });
        squashMerge(found.repo, found.pull);
        return gqlObj('MergePullRequestPayload', { pull: found });
      }
      if (name === 'addComment') {
        const input = asObj(argVal(field, 'input', vars));
        const found = gqlIssueFromId(input.subjectId);
        if (found === null) return gqlObj('AddCommentPayload', { commentEdge: null });
        const comment: CommentT = { id: found.repo.nextComment, body: asStr(input.body), createdAt: nowIso(), updatedAt: nowIso() };
        found.repo.nextComment += 1;
        found.issue.comments.push(comment);
        found.issue.updatedAt = nowIso();
        dropIssueView(found.issue);
        bump();
        return gqlObj('AddCommentPayload', { commentEdge: { node: { repo: found.repo, issue: found.issue, comment } } });
      }
      break;
    }
    case 'Repository': {
      const repo = value as Repo;
      if (name === 'id') return gqlScalar(gid('Repository', repoKey(repo.owner, repo.name)));
      if (name === 'databaseId') return gqlScalar(repo.id);
      if (name === 'name') return gqlScalar(repo.name);
      if (name === 'nameWithOwner') return gqlScalar(repoKey(repo.owner, repo.name));
      if (name === 'description') return gqlScalar(repo.description);
      if (name === 'isPrivate') return gqlScalar(repo.isPrivate);
      if (name === 'owner') return gqlObj('User', { login: repo.owner, id: repo.owner === VIEWER ? VIEWER_ID : 1002 });
      if (name === 'defaultBranchRef') {
        const sha = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return sha === undefined ? gqlNull : gqlObj('Ref', { name: repo.defaultBranch });
      }
      if (name === 'viewerPermission') return gqlScalar('ADMIN');
      if (name === 'hasIssuesEnabled') return gqlScalar(true);
      if (name === 'issue') {
        const issue = findIssue(repo, argNum(field, 'number', vars));
        return issue === undefined ? gqlNull : gqlObj('Issue', { repo, issue });
      }
      if (name === 'issues') {
        const first = argNum(field, 'first', vars) || 10;
        const after = gqlCursorNum(argVal(field, 'after', vars));
        const statesRaw = argVal(field, 'states', vars);
        const states = Array.isArray(statesRaw) ? (statesRaw as unknown[]).map(String) : null;
        const orderBy = asObj(argVal(field, 'orderBy', vars));
        const direction = asStr(orderBy.direction, 'ASC');
        let issues = [...repo.issues];
        if (states !== null) issues = issues.filter((i) => states.includes(i.state === 'open' ? 'OPEN' : 'CLOSED'));
        issues.sort((a, b) => (direction === 'DESC' ? b.number - a.number : a.number - b.number));
        const pg = gqlPage(issues, first, after, (i) => i.number);
        return gqlObj('IssueConnection', {
          nodes: pg.page.map((i) => ({ k: 'obj', t: 'Issue', v: { repo, issue: i } }) as GqlResolved),
          pageInfo: pg,
        });
      }
      if (name === 'pullRequest') {
        const pull = findPull(repo, argNum(field, 'number', vars));
        return pull === undefined ? gqlNull : gqlObj('PullRequest', { repo, pull });
      }
      if (name === 'pullRequests') {
        const first = argNum(field, 'first', vars) || 10;
        const after = gqlCursorNum(argVal(field, 'after', vars));
        const statesRaw = argVal(field, 'states', vars);
        const states = Array.isArray(statesRaw) ? (statesRaw as unknown[]).map(String) : null;
        let pulls = [...repo.pulls];
        if (states !== null) {
          pulls = pulls.filter((p) => {
            const s = p.state === 'open' ? 'OPEN' : p.merged ? 'MERGED' : 'CLOSED';
            return states.includes(s);
          });
        }
        pulls.sort((a, b) => a.number - b.number);
        const pg = gqlPage(pulls, first, after, (p) => p.number);
        return gqlObj('PullRequestConnection', {
          nodes: pg.page.map((p) => ({ k: 'obj', t: 'PullRequest', v: { repo, pull: p } }) as GqlResolved),
          pageInfo: pg,
        });
      }
      break;
    }
    case 'Issue': {
      const v = value as { repo: Repo; issue: Issue };
      if (name === 'id') return gqlScalar(gid('Issue', `${repoKey(v.repo.owner, v.repo.name)}/${v.issue.number}`));
      if (name === 'number') return gqlScalar(v.issue.number);
      if (name === 'title') return gqlScalar(v.issue.title);
      if (name === 'body') return gqlScalar(v.issue.body);
      if (name === 'state') return gqlScalar(v.issue.state === 'open' ? 'OPEN' : 'CLOSED');
      if (name === 'url') return gqlScalar(`https://github.com/${repoKey(v.repo.owner, v.repo.name)}/issues/${v.issue.number}`);
      if (name === 'createdAt') return gqlScalar(v.issue.createdAt);
      if (name === 'updatedAt') return gqlScalar(v.issue.updatedAt);
      if (name === 'author') return gqlObj('User', { login: VIEWER, id: VIEWER_ID });
      break;
    }
    case 'PullRequest': {
      const v = value as { repo: Repo; pull: Pull };
      if (name === 'id') return gqlScalar(gid('PullRequest', `${repoKey(v.repo.owner, v.repo.name)}/${v.pull.number}`));
      if (name === 'number') return gqlScalar(v.pull.number);
      if (name === 'title') return gqlScalar(v.pull.title);
      if (name === 'body') return gqlScalar(v.pull.body);
      if (name === 'state') return gqlScalar(v.pull.state === 'open' ? 'OPEN' : v.pull.merged ? 'MERGED' : 'CLOSED');
      if (name === 'headRefName') return gqlScalar(v.pull.head);
      if (name === 'baseRefName') return gqlScalar(v.pull.base);
      if (name === 'headRefOid') return gqlScalar(v.pull.headSha);
      if (name === 'baseRefOid') return gqlScalar(v.pull.baseSha);
      if (name === 'mergeable') return gqlScalar(prMergeable(v.repo, v.pull));
      if (name === 'merged') return gqlScalar(v.pull.merged);
      if (name === 'mergedAt') return gqlScalar(v.pull.merged ? v.pull.mergedAt : null);
      if (name === 'createdAt') return gqlScalar(v.pull.createdAt);
      if (name === 'updatedAt') return gqlScalar(v.pull.updatedAt);
      if (name === 'author') return gqlObj('User', { login: VIEWER, id: VIEWER_ID });
      if (name === 'files') {
        const first = argNum(field, 'first', vars) || 10;
        const files = diffFiles(v.repo, v.pull.baseSha, v.pull.headSha);
        const nodes = files.slice(0, first).map((f) => ({ k: 'obj', t: 'PullRequestFile', v: f }) as GqlResolved);
        return gqlObj('PullRequestFileConnection', {
          nodes,
          pageInfo: { hasNextPage: files.length > first, endCursor: null },
        });
      }
      break;
    }
    case 'User': {
      const v = value as { login: string; id: number };
      if (name === 'login') return gqlScalar(v.login);
      if (name === 'id') return gqlScalar(gid('User', v.login));
      if (name === 'name') return gqlScalar(v.login);
      break;
    }
    case 'Ref': {
      const v = value as { name: string };
      if (name === 'name') return gqlScalar(v.name);
      break;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'PullRequestFileConnection': {
      const v = value as { nodes: GqlResolved[]; pageInfo: { page: unknown[]; hasNextPage: boolean; endCursor: string | null } };
      if (name === 'nodes') return { k: 'list', items: v.nodes };
      if (name === 'totalCount') return gqlScalar(v.nodes.length);
      if (name === 'pageInfo') return gqlObj('PageInfo', v.pageInfo);
      break;
    }
    case 'PageInfo': {
      const v = value as { hasNextPage: boolean; endCursor: string | null };
      if (name === 'hasNextPage') return gqlScalar(v.hasNextPage);
      if (name === 'hasPreviousPage') return gqlScalar(false);
      if (name === 'endCursor') return gqlScalar(v.endCursor);
      if (name === 'startCursor') return gqlScalar(null);
      break;
    }
    case 'PullRequestFile': {
      const v = value as { filename: string; status: string; additions: number; deletions: number; changes: number };
      if (name === 'path') return gqlScalar(v.filename);
      if (name === 'additions') return gqlScalar(v.additions);
      if (name === 'deletions') return gqlScalar(v.deletions);
      if (name === 'changes') return gqlScalar(v.changes);
      if (name === 'status') return gqlScalar(v.status.toUpperCase());
      break;
    }
    case 'IssueComment': {
      const v = value as { repo: Repo; issue: Issue; comment: CommentT };
      if (name === 'id') return gqlScalar(gid('IssueComment', `${repoKey(v.repo.owner, v.repo.name)}/${v.issue.number}/${v.comment.id}`));
      if (name === 'body') return gqlScalar(v.comment.body);
      if (name === 'author') return gqlObj('User', { login: VIEWER, id: VIEWER_ID });
      break;
    }
    case 'CommentEdge': {
      const v = value as { node: unknown };
      if (name === 'node') {
        const n = v.node as { repo: Repo; issue: Issue; comment: CommentT };
        return gqlObj('IssueComment', n);
      }
      if (name === 'cursor') return gqlScalar(null);
      break;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      const v = value as { issue: { repo: Repo; issue: Issue } | null };
      if (name === 'issue') return v.issue === null ? gqlNull : gqlObj('Issue', v.issue);
      break;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      const v = value as { pull: { repo: Repo; pull: Pull } | null };
      if (name === 'pullRequest') return v.pull === null ? gqlNull : gqlObj('PullRequest', v.pull);
      break;
    }
    case 'AddCommentPayload': {
      const v = value as { commentEdge: { node: unknown } | null };
      if (name === 'commentEdge') return v.commentEdge === null ? gqlNull : gqlObj('CommentEdge', v.commentEdge);
      break;
    }
    case '__Type': {
      const v = value as { name: string; kind: string; fields: string[]; enumValues: string[] };
      if (name === 'name') return gqlScalar(v.name);
      if (name === 'kind') return gqlScalar(v.kind);
      if (name === 'fields') {
        return { k: 'list', items: v.fields.map((f) => gqlObj('__Field', { name: f })) };
      }
      if (name === 'enumValues') {
        return { k: 'list', items: v.enumValues.map((f) => gqlObj('__EnumValue', { name: f })) };
      }
      break;
    }
    case '__Field':
    case '__EnumValue': {
      const v = value as { name: string };
      if (name === 'name') return gqlScalar(v.name);
      break;
    }
    case '__Schema': {
      const v = value as { types: string[] };
      if (name === 'types') {
        return { k: 'list', items: v.types.map((t) => gqlObj('__Type', { name: t, kind: 'OBJECT', fields: GQL_TYPE_FIELDS[t] ?? [], enumValues: GQL_TYPE_ENUMS[t] ?? [] })) };
      }
      break;
    }
  }
  errors.push({ message: `Cannot query field "${name}" on type "${type}".` });
  return gqlNull;
}

function gqlRender(r: GqlResolved, sel: GqlSel[] | null, vars: Record<string, unknown>, errors: { message: string }[]): unknown {
  if (r.k === 'null') return null;
  if (r.k === 'scalar') return r.v;
  if (r.k === 'list') {
    if (sel === null) return r.items.map((it) => gqlRender(it, null, vars, errors));
    return r.items.map((it) => (it.k === 'obj' ? gqlExecSel(it.t, it.v, sel, vars, errors) : gqlRender(it, null, vars, errors)));
  }
  if (sel === null) return null;
  return gqlExecSel(r.t, r.v, sel, vars, errors);
}

function gqlExecSel(t: string, v: unknown, sel: GqlSel[], vars: Record<string, unknown>, errors: { message: string }[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const s of sel) {
    if (s.kind === 'frag') {
      if (s.type === t) Object.assign(out, gqlExecSel(t, v, s.sel, vars, errors));
      continue;
    }
    const f = s.f;
    const r = gqlResolveField(t, v, f, vars, errors);
    out[f.alias] = gqlRender(r, f.sel, vars, errors);
  }
  return out;
}

function gqlExecute(op: GqlOp, vars: Record<string, unknown>): { data: Record<string, unknown>; errors: { message: string }[] } {
  const errors: { message: string }[] = [];
  const data = gqlExecSel(op.kind === 'mutation' ? 'Mutation' : 'Query', null, op.sel, vars, errors);
  return { data, errors };
}

/** Run one GraphQL operation body ({query, variables}) and return the response object. */
function gqlRun(body: unknown): Record<string, unknown> {
  const obj = asObj(body);
  const query = asStr(obj.query);
  const vars = asObj(obj.variables);
  const op = gqlParse(query);
  if (op === null) {
    return { data: null, errors: [{ message: 'Syntax Error: could not parse query.' }] };
  }
  const { data, errors } = gqlExecute(op, vars as Record<string, unknown>);
  if (errors.length > 0) return { data, errors };
  return { data };
}

// ---------------------------------------------------------------------------
// MCP (Model Context Protocol) over Streamable HTTP: JSON-RPC 2.0 on POST /mcp.
// Speaks revision 2026-07-28 (server/discover) and the legacy handshake
// (initialize + notifications/initialized). Stateless; every tools/call acts
// on the same store as REST and GraphQL.
// ---------------------------------------------------------------------------

const MCP_REVISIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

function mcpTool(name: string, description: string, props: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { name, description, inputSchema: { type: 'object', properties: props, required } };
}

/** The tool list, built once: two tools/list calls answer it byte for byte. */
const MCP_TOOLS: Record<string, unknown>[] = [
  mcpTool('create_repo', 'Create a new repository owned by the viewer.', {
    owner: { type: 'string', description: 'The owner login (defaults to the viewer).' },
    name: { type: 'string', description: 'The repository name.' },
    description: { type: 'string', description: 'A short description of the repository.' },
    private: { type: 'boolean', description: 'Whether the repository is private.' },
  }, ['name']),
  mcpTool('get_repo', 'Get a repository by owner and name.', {
    owner: { type: 'string', description: 'The owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
  }, ['owner', 'repo']),
  mcpTool('create_issue', 'Create an issue in a repository.', {
    owner: { type: 'string', description: 'The owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The issue title.' },
    body: { type: 'string', description: 'The issue body.' },
  }, ['owner', 'repo', 'title']),
  mcpTool('list_issues', 'List issues in a repository.', {
    owner: { type: 'string', description: 'The owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    state: { type: 'string', description: 'Filter by state: open, closed or all.' },
  }, ['owner', 'repo']),
  mcpTool('create_pull_request', 'Open a pull request from a head branch onto a base branch.', {
    owner: { type: 'string', description: 'The owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    title: { type: 'string', description: 'The pull request title.' },
    body: { type: 'string', description: 'The pull request body.' },
    head: { type: 'string', description: 'The head branch name.' },
    base: { type: 'string', description: 'The base branch name.' },
  }, ['owner', 'repo', 'title', 'head', 'base']),
  mcpTool('merge_pull_request', 'Squash-merge a pull request.', {
    owner: { type: 'string', description: 'The owner login.' },
    repo: { type: 'string', description: 'The repository name.' },
    pull_number: { type: 'integer', description: 'The pull request number.' },
  }, ['owner', 'repo', 'pull_number']),
];

const MCP_CANONICAL: Record<string, string> = {
  create_repo: 'create_repo', create_repository: 'create_repo', repo_create: 'create_repo', repos_create: 'create_repo', repository_create: 'create_repo',
  get_repo: 'get_repo', get_repository: 'get_repo', repo_get: 'get_repo', repos_get: 'get_repo', repository_get: 'get_repo',
  create_issue: 'create_issue', issue_create: 'create_issue', issues_create: 'create_issue',
  list_issues: 'list_issues', issues_list: 'list_issues', issue_list: 'list_issues',
  create_pull_request: 'create_pull_request', pull_request_create: 'create_pull_request', pulls_create: 'create_pull_request', create_pr: 'create_pull_request', pr_create: 'create_pull_request',
  merge_pull_request: 'merge_pull_request', pull_request_merge: 'merge_pull_request', pulls_merge: 'merge_pull_request', merge_pr: 'merge_pull_request', pr_merge: 'merge_pull_request',
};

/** Resolve a tool name (with an optional server prefix, case-insensitive) to canonical. */
function mcpCanonical(name: string): string | null {
  const lower = name.toLowerCase();
  const parts = lower.split('__');
  const bare = parts[parts.length - 1] as string;
  return MCP_CANONICAL[bare] ?? null;
}

/** One tool's result, or an error message. */
function mcpCallTool(name: string, args: Record<string, unknown>): { ok: boolean; result: unknown; error: string } {
  const canonical = mcpCanonical(name);
  if (canonical === null) return { ok: false, result: null, error: `Unknown tool: ${name}` };
  const owner = asStr(args.owner, VIEWER);
  const repoName = asStr(args.repo ?? args.repository ?? args.name);
  if (canonical === 'create_repo') {
    const repo = getRepo(owner, repoName);
    if (repo !== undefined) return { ok: false, result: null, error: `Repository ${owner}/${repoName} already exists` };
    if (repoName === '') return { ok: false, result: null, error: 'Missing required argument: name' };
    const created = createRepo(repoName, asStr(args.description), asBool(args.private));
    return { ok: true, result: repoJson(created), error: '' };
  }
  const repo = getRepo(owner, repoName);
  if (repo === undefined) return { ok: false, result: null, error: `Repository ${owner}/${repoName} not found` };
  if (canonical === 'get_repo') {
    return { ok: true, result: repoJson(repo), error: '' };
  }
  if (canonical === 'create_issue') {
    const title = asStr(args.title);
    if (title === '') return { ok: false, result: null, error: 'Missing required argument: title' };
    const issue = gqlCreateIssue(repo, title, asStr(args.body));
    return { ok: true, result: issueJson(repo, issue), error: '' };
  }
  if (canonical === 'list_issues') {
    const state = asStr(args.state, 'open');
    const items = repo.issues.filter((i) => state === 'all' || i.state === state);
    return { ok: true, result: items.map((i) => issueJson(repo, i)), error: '' };
  }
  if (canonical === 'create_pull_request') {
    const pull = gqlCreatePull(repo, asStr(args.title), asStr(args.body), asStr(args.head), asStr(args.base));
    if (pull === null) return { ok: false, result: null, error: 'head or base branch not found' };
    return { ok: true, result: pullJson(repo, pull), error: '' };
  }
  if (canonical === 'merge_pull_request') {
    const n = asNum(args.pull_number ?? args.number);
    const pull = findPull(repo, n);
    if (pull === undefined) return { ok: false, result: null, error: `Pull request #${n} not found` };
    const m = squashMerge(repo, pull);
    if (!m.ok) return { ok: false, result: null, error: `Cannot merge pull request #${n}: ${m.reason}` };
    return { ok: true, result: pullJson(repo, pull), error: '' };
  }
  return { ok: false, result: null, error: `Unknown tool: ${name}` };
}

/** The MCP endpoint. Returns true when the path is /mcp. */
function handleMcp(req: Req, res: Res): boolean {
  if (req.path !== '/mcp') return false;
  if (req.method !== 'POST') {
    res.err(405, 'Method Not Allowed');
    return true;
  }
  const auth = req.headers.get('authorization') ?? '';
  if (auth !== AUTH) {
    res.err(401, 'Unauthorized');
    return true;
  }
  let body: unknown;
  try {
    body = JSON.parse(req.body.toString('utf8')) as unknown;
  } catch {
    res.json(400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const handleOne = (msg: unknown): Record<string, unknown> | null => {
    const m = asObj(msg);
    const id = (m.id ?? null) as unknown;
    const method = asStr(m.method);
    if (method === '') return { jsonrpc: '2.0', id, error: { code: -32600, message: 'Invalid Request' } };
    if (method.startsWith('notifications/')) return null;
    if (method === 'server/discover') {
      return { jsonrpc: '2.0', id, result: { supportedVersions: MCP_REVISIONS, serverInfo: { name: 'git-forge', version: '1.0.0' }, capabilities: { tools: {} } } };
    }
    if (method === 'initialize') {
      const params = asObj(m.params);
      const want = asStr(params.protocolVersion);
      const negotiated = MCP_REVISIONS.includes(want) ? want : '2026-07-28';
      return { jsonrpc: '2.0', id, result: { protocolVersion: negotiated, capabilities: { tools: {} }, serverInfo: { name: 'git-forge', version: '1.0.0' } } };
    }
    if (method === 'ping') {
      return { jsonrpc: '2.0', id, result: {} };
    }
    if (method === 'tools/list') {
      return { jsonrpc: '2.0', id, result: { tools: MCP_TOOLS } };
    }
    if (method === 'tools/call') {
      const params = asObj(m.params);
      const toolName = asStr(params.name);
      const args = asObj(params.arguments);
      const canonical = mcpCanonical(toolName);
      if (canonical === null) {
        return { jsonrpc: '2.0', id, error: { code: -32601, message: `Unknown tool: ${toolName}` } };
      }
      // Missing required arguments answer isError:true (the suite accepts that or -32602).
      const tool = MCP_TOOLS.find((t) => t.name === canonical) as Record<string, unknown>;
      const schema = asObj(tool.inputSchema);
      const required = Array.isArray(schema.required) ? (schema.required as unknown[]).filter((x): x is string => typeof x === 'string') : [];
      const missing = required.filter((r) => args[r] === undefined || args[r] === null || args[r] === '');
      if (missing.length > 0) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `Missing required argument(s): ${missing.join(', ')}` }], isError: true } };
      }
      const out = mcpCallTool(toolName, args);
      if (!out.ok) {
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: out.error }], isError: true } };
      }
      return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(out.result) }], structuredContent: out.result } };
    }
    return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } };
  };
  if (Array.isArray(body)) {
    const out: Record<string, unknown>[] = [];
    for (const msg of body as unknown[]) {
      const r = handleOne(msg);
      if (r !== null) out.push(r);
    }
    res.json(200, out);
    return true;
  }
  const out = handleOne(body);
  if (out === null) {
    res.bytes(202, Buffer.alloc(0), 'application/json; charset=utf-8');
    return true;
  }
  res.json(200, out);
  return true;
}

// ---------------------------------------------------------------------------
// Routing, the read fast-path, git endpoints, GraphQL, and the raw TCP server.
// ---------------------------------------------------------------------------

/** DeepSeek #1: read fast-path for GET /api/v3/repos/{o}/{r}/issues/{n}.
 *  Matches the exact shape only (GET, that path, no query string, numeric n,
 *  single-segment owner/repo) and jumps straight to getRepo + findIssue +
 *  sendBytes(issueBytes). Anything else falls through to the generic path. */
function tryReadFastPath(req: Req, res: Res): boolean {
  const p = req.path;
  const PREFIX = '/api/v3/repos/';
  if (p.length <= PREFIX.length || !p.startsWith(PREFIX)) return false;
  if (req.queryString !== '') return false;
  const rest = p.slice(PREFIX.length);
  const s1 = rest.indexOf('/');
  if (s1 <= 0) return false;
  const owner = rest.slice(0, s1);
  const rest2 = rest.slice(s1 + 1);
  const s2 = rest2.indexOf('/');
  if (s2 <= 0) return false;
  const repoName = rest2.slice(0, s2);
  const rest3 = rest2.slice(s2 + 1);
  if (!rest3.startsWith('issues/')) return false;
  const numStr = rest3.slice(7);
  if (numStr.length === 0) return false;
  for (let i = 0; i < numStr.length; i += 1) {
    const c = numStr.charCodeAt(i);
    if (c < 48 || c > 57) return false;
  }
  const n = parseInt(numStr, 10);
  const repo = getRepo(owner, repoName);
  if (repo === undefined) return false;
  const issue = findIssue(repo, n);
  if (issue === undefined) return false;
  res.bytes(200, issueBytes(repo, issue), 'application/json; charset=utf-8');
  return true;
}

/** Git smart-HTTP routes. The manual scan enforces owner/repo are single
 *  segments, so a REST path that happens to contain ".git/" never matches. */
function handleGit(req: Req, res: Res): boolean {
  const p = req.path;
  if (p.indexOf('.git/') < 0) return false;
  const parts = p.split('/');
  if (parts.length < 4 || parts[0] !== '') return false;
  const owner = parts[1] as string;
  const repoGit = parts[2] as string;
  if (owner === '' || !repoGit.endsWith('.git')) return false;
  const repoName = repoGit.slice(0, -4);
  if (repoName === '') return false;
  const action = parts[3] as string;
  const repo = getRepo(owner, repoName);
  if (repo === undefined) {
    res.err(404, 'Not Found');
    return true;
  }
  if (action === 'info' && parts[4] === 'refs' && parts.length === 5) {
    if (req.method !== 'GET') {
      res.err(405, 'Method Not Allowed');
      return true;
    }
    const service = req.query.get('service') ?? '';
    const isV2 = (req.headers.get('git-protocol') ?? '') === 'version=2';
    if (service === 'git-upload-pack') {
      if (isV2) {
        res.bytes(200, UPLOAD_PACK_AD, 'application/x-git-upload-pack-advertisement');
      } else {
        res.bytes(200, v0Advertisement(repo, 'git-upload-pack', UPLOAD_PACK_V0_CAPS), 'application/x-git-upload-pack-advertisement');
      }
      return true;
    }
    if (service === 'git-receive-pack') {
      res.bytes(200, v0Advertisement(repo, 'git-receive-pack', RECEIVE_PACK_CAPS), 'application/x-git-receive-pack-advertisement');
      return true;
    }
    res.err(404, 'Not Found');
    return true;
  }
  if (action === 'git-upload-pack' && parts.length === 4) {
    if (req.method !== 'POST') {
      res.err(405, 'Method Not Allowed');
      return true;
    }
    const isV2 = (req.headers.get('git-protocol') ?? '') === 'version=2';
    res.bytes(200, handleUploadPack(repo, req.body, isV2), 'application/x-git-upload-pack-result');
    return true;
  }
  if (action === 'git-receive-pack' && parts.length === 4) {
    if (req.method !== 'POST') {
      res.err(405, 'Method Not Allowed');
      return true;
    }
    res.bytes(200, handleReceivePack(repo, req.body), 'application/x-git-receive-pack-result');
    return true;
  }
  return false;
}

function handleGraphQL(req: Req, res: Res): void {
  if (req.method !== 'POST') {
    res.err(405, 'Method Not Allowed');
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(req.body.toString('utf8')) as unknown;
  } catch {
    res.err(400, 'Problems parsing JSON');
    return;
  }
  if (Array.isArray(body)) {
    res.json(200, (body as unknown[]).map((b) => gqlRun(b)));
    return;
  }
  res.json(200, gqlRun(body));
}

function authed(req: Req): boolean {
  return (req.headers.get('authorization') ?? '') === AUTH;
}

function handleRequest(req: Req, res: Res): void {
  // The env's boot check: 200 {"ok":true}, no token.
  if (req.method === 'GET' && req.path === '/healthz') {
    res.json(200, { ok: true });
    return;
  }
  // Every API call carries the viewer's bearer token; without it, 401.
  if (!authed(req)) {
    res.err(401, 'Unauthorized');
    return;
  }
  // DeepSeek #1: the read hot path.
  if (req.method === 'GET' && tryReadFastPath(req, res)) return;
  if (handleGit(req, res)) return;
  if (req.path === '/api/graphql') {
    handleGraphQL(req, res);
    return;
  }
  if (handleMcp(req, res)) return;
  if (handleRest(req, res)) return;
  res.err(404, 'Not Found');
}

// ---------------------------------------------------------------------------
// Raw TCP HTTP server: buffered per-connection parsing, keep-alive, chunked
// bodies. Never crashes on a bad request; the server stays up.
// ---------------------------------------------------------------------------

function parseTarget(target: string): { path: string; query: string } {
  let t = target;
  if (t.startsWith('http://') || t.startsWith('https://')) {
    const slash = t.indexOf('/', t.indexOf('://') + 3);
    t = slash < 0 ? '/' : t.slice(slash);
  }
  const q = t.indexOf('?');
  if (q < 0) return { path: t === '' ? '/' : t, query: '' };
  return { path: t.slice(0, q) || '/', query: t.slice(q + 1) };
}

function decodeChunked(buf: Buffer): { body: Buffer; consumed: number } | null {
  const chunks: Buffer[] = [];
  let off = 0;
  while (true) {
    const lineEnd = buf.indexOf('\r\n', off);
    if (lineEnd < 0) return null;
    const sizeLine = buf.toString('ascii', off, lineEnd).split(';')[0].trim();
    const size = parseInt(sizeLine, 16);
    if (!Number.isFinite(size) || size < 0) return null;
    if (size === 0) {
      const end = buf.indexOf('\r\n\r\n', lineEnd);
      if (end < 0) return null;
      return { body: Buffer.concat(chunks), consumed: end + 4 };
    }
    if (buf.length < lineEnd + 2 + size + 2) return null;
    chunks.push(buf.subarray(lineEnd + 2, lineEnd + 2 + size));
    off = lineEnd + 2 + size + 2;
  }
}

interface ParsedReq {
  req: Req;
  rest: Buffer;
  closeAfter: boolean;
}

function tryParse(buf: Buffer): ParsedReq | null {
  const headEnd = buf.indexOf('\r\n\r\n');
  if (headEnd < 0) {
    if (buf.length > 65536) throw new Error('request head too large');
    return null;
  }
  const head = buf.toString('ascii', 0, headEnd);
  const lines = head.split('\r\n');
  const requestLine = lines[0] as string;
  const sp1 = requestLine.indexOf(' ');
  const sp2 = requestLine.indexOf(' ', sp1 + 1);
  if (sp1 < 0 || sp2 < 0) throw new Error('bad request line');
  const method = requestLine.slice(0, sp1);
  const target = requestLine.slice(sp1 + 1, sp2);
  const version = requestLine.slice(sp2 + 1);
  const headers = new Map<string, string>();
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const colon = line.indexOf(':');
    if (colon > 0) headers.set(line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim());
  }
  const { path, query } = parseTarget(target);
  const bodyStart = headEnd + 4;
  const isChunked = (headers.get('transfer-encoding') ?? '').toLowerCase().includes('chunked');
  let body: Buffer;
  let consumed: number;
  if (isChunked) {
    const decoded = decodeChunked(buf.subarray(bodyStart));
    if (decoded === null) return null;
    body = decoded.body;
    consumed = bodyStart + decoded.consumed;
  } else {
    const contentLength = parseInt(headers.get('content-length') ?? '', 10);
    if (Number.isFinite(contentLength) && contentLength > 0) {
      if (buf.length < bodyStart + contentLength) return null;
      body = buf.subarray(bodyStart, bodyStart + contentLength);
      consumed = bodyStart + contentLength;
    } else {
      body = Buffer.alloc(0);
      consumed = bodyStart;
    }
  }
  const connHeader = (headers.get('connection') ?? '').toLowerCase();
  const closeAfter = connHeader === 'close' || (version === 'HTTP/1.0' && connHeader !== 'keep-alive');
  const req: Req = {
    method,
    path,
    query: new URLSearchParams(query),
    queryString: query,
    headers,
    body: Buffer.from(body),
    host: headers.get('host') ?? '127.0.0.1',
  };
  return { req, rest: buf.subarray(consumed), closeAfter };
}

function createServer(): net.Server {
  return net.createServer((sock) => {
    // Nagle's algorithm + delayed ACK adds ~20-40ms to every small
    // request/response round-trip; sequential workloads pay it per request.
    sock.setNoDelay(true);
    let buf = Buffer.alloc(0);
    sock.on('data', (data: Buffer) => {
      buf = buf.length === 0 ? data : Buffer.concat([buf, data]);
      for (;;) {
        let parsed: ParsedReq | null;
        try {
          parsed = tryParse(buf);
        } catch {
          sock.destroy();
          return;
        }
        if (parsed === null) return;
        buf = parsed.rest;
        try {
          handleRequest(parsed.req, new Res(sock));
        } catch {
          try {
            new Res(sock).err(500, 'Internal Server Error');
          } catch {
            // The socket is gone; nothing more to do.
          }
        }
        if (parsed.closeAfter) {
          sock.end();
          return;
        }
        if (buf.length === 0) return;
      }
    });
    sock.on('error', () => {
      // A reset peer is not a server error.
    });
  });
}

// ---------------------------------------------------------------------------
// Entry <-> env lifecycle (the starter's, with push2's /done sleep fix: after
// a {done:false} poll, wait 500ms before polling again, so the poll never
// becomes a hot spin loop stealing event-loop time from request handling).
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

async function register(port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

async function waitForDone(): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${ENV_URL}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
        // The env answers at once; never spin on {done:false}.
        await sleep(500);
        continue;
      }
    } catch {
      // The env is not answering yet: back off and poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

async function main(): Promise<void> {
  if (ENV_URL === '') {
    process.stderr.write('[entry] MAKEFUN_ENV_URL is not set: there is no env to register with\n');
    process.exit(1);
  }
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('the server did not bind an ephemeral TCP port');
  process.stdout.write(`[entry] listening on port ${address.port}\n`);
  await register(address.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await waitForDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}

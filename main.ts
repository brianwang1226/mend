// main.ts is mend, the CLI SPEC.md specifies, and this is the kit's starting point for it (MIT). It does sections 1 to 4, 9 and 10 of SPEC.md: the command line, the output and
// exit codes, safe paths, format detection, JSON edits and the all-or-nothing write. The other three formats are
// detected and then read as holding no edit, so they answer `error: parse 1`: reading unified diffs (section 6),
// SEARCH/REPLACE blocks (section 7) and V4A patches (section 8), and matching lines at three tiers (section 5), are
// yours to write. Node 22, the standard library alone; run it as `node main.ts [options] [PATCH]`.
//
// In a trial the grader runs `node /bot/main.ts` with MAKEFUN_ENV_URL set, and then this file hands over to runner.ts
// (the last lines below): keep that hand-over and runner.ts as they are, and write the CLI.

import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

const FORMATS = ['auto', 'unified', 'search-replace', 'v4a', 'json'];

class Exit2 {
  readonly line: string;
  constructor(line: string) {
    this.line = line;
  }
}
class Fail {
  readonly code: string;
  readonly path: string;
  constructor(code: string, path: string) {
    this.code = code;
    this.path = path;
  }
}

const blank = (s: string): boolean => s.trim() === '';

function patchLines(text: string): string[] {
  if (text === '') return [];
  const lines = text.split('\n');
  if (text.endsWith('\n')) lines.pop();
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
}

function safe(p: string): boolean {
  return p !== '' && !p.startsWith('/') && !p.includes('\\') && p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** The tree as the edits leave it: changed paths in `now` (null: deleted), the rest read from disk. */
class Tree {
  private readonly orig = new Map<string, string | null>();
  private readonly dirs = new Map<string, boolean>();
  readonly now = new Map<string, string | null>();
  original(p: string): string | null {
    if (!this.orig.has(p)) {
      let v: string | null = null;
      try {
        if (statSync(p).isFile()) v = readFileSync(p, 'utf8');
      } catch {
        v = null;
      }
      this.orig.set(p, v);
    }
    return this.orig.get(p)!;
  }
  get(p: string): string | null {
    return this.now.has(p) ? this.now.get(p)! : this.original(p);
  }
  isDir(p: string): boolean {
    if (!this.dirs.has(p)) {
      let v = false;
      try {
        v = statSync(p).isDirectory();
      } catch {
        v = false;
      }
      this.dirs.set(p, v);
    }
    return this.dirs.get(p)!;
  }
  /** True when the path holds a file in the tree as the edits left it, or a directory on disk. */
  exists(p: string): boolean {
    return this.get(p) !== null || this.isDir(p);
  }
}

/** A text file as lines: its line break, its lines, whether it ends with a break. */
interface FModel {
  br: '\r\n' | '\n';
  lines: string[];
  fin: boolean;
}

function parseFile(text: string): FModel {
  if (text === '') return { br: '\n', lines: [], fin: false };
  const nl = text.indexOf('\n');
  const br: '\r\n' | '\n' = nl > 0 && text[nl - 1] === '\r' ? '\r\n' : '\n';
  const parts = text.split(br);
  const fin = text.endsWith(br);
  if (fin) parts.pop();
  return { br, lines: parts, fin };
}

function serializeFile(m: FModel): string {
  if (m.lines.length === 0) return '';
  return m.lines.join(m.br) + (m.fin ? m.br : '');
}

const rstrip = (s: string): string => s.replace(/[ \t]+$/, '');
const stripWs = (s: string): string => s.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
const leadWs = (s: string): string => {
  const m = /^[ \t]*/.exec(s);
  return m === null ? '' : m[0];
};

function tierEq(a: string, b: string, t: number): boolean {
  if (t === 0) return a === b;
  if (t === 1) return rstrip(a) === rstrip(b);
  return stripWs(a) === stripWs(b);
}

/** Positions where O occurs in F at tier t, at or after `from`. */
function occAt(O: string[], F: string[], t: number, from: number): number[] {
  const out: number[] = [];
  if (O.length === 0) return out;
  for (let i = from; i + O.length <= F.length; i++) {
    let ok = true;
    for (let j = 0; j < O.length; j++) {
      if (!tierEq(O[j]!, F[i + j]!, t)) {
        ok = false;
        break;
      }
    }
    if (ok) out.push(i);
  }
  return out;
}

/** The first tier (0, 1, 2; only 0 when strict) at which O occurs in F at or after `from`. */
function findTier(O: string[], F: string[], strict: boolean, from = 0): { t: number; occ: number[] } | null {
  const tiers = strict ? [0] : [0, 1, 2];
  for (const t of tiers) {
    const occ = occAt(O, F, t, from);
    if (occ.length > 0) return { t, occ };
  }
  return null;
}

/** One body line of a unified hunk or a V4A chunk. */
interface BEntry {
  k: ' ' | '-' | '+' | '\\';
  text: string;
}

const oldLinesOf = (es: BEntry[]): string[] => es.filter((e) => e.k === ' ' || e.k === '-').map((e) => e.text);
const newCountOf = (es: BEntry[]): number => es.filter((e) => e.k === ' ' || e.k === '+').length;

/**
 * The lines that replace the matched span: context lines are the file's own
 * matched lines; other lines of N are the patch's, re-indented at tier 2.
 */
function buildReplacement(F: string[], at: number, es: BEntry[], tier: number): string[] {
  const o = es.filter((e) => e.k === ' ' || e.k === '-');
  const oCtx: number[] = [];
  o.forEach((e, i) => {
    if (e.k === ' ') oCtx.push(i);
  });
  const P = o.length > 0 ? leadWs(o[0]!.text) : '';
  const F0 = at < F.length ? leadWs(F[at]!) : '';
  const out: string[] = [];
  let ctx = 0;
  for (const e of es) {
    if (e.k === '+') {
      let line = e.text;
      if (tier === 2 && line !== '' && line.trim() !== '' && line.startsWith(P)) line = F0 + line.slice(P.length);
      out.push(line);
    } else if (e.k === ' ') {
      out.push(F[at + oCtx[ctx]!]!);
      ctx += 1;
    }
  }
  return out;
}

/** True when a `\` line follows the hunk's last context or `+` line. */
function noFinalBreak(es: BEntry[]): boolean {
  for (let i = es.length - 1; i >= 0; i--) {
    if (es[i]!.k === ' ' || es[i]!.k === '+') return es[i + 1] !== undefined && es[i + 1]!.k === '\\';
  }
  return false;
}

/** What a format reader returns: the edits, and the move pairs its edits make. */
interface Parsed {
  edits: Edit[];
  moves: Array<[string, string]>;
}

type Edit = (tree: Tree) => void;

function detect(lines: string[]): string | null {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) return null;
  if (lines[first]!.trim() === '*** Begin Patch') return 'v4a';
  const c = lines[first]!.trimStart()[0];
  if (c === '[' || c === '{') return 'json';
  if (lines.some((l) => l.trimEnd() === '<<<<<<< SEARCH')) return 'search-replace';
  if (lines.some((l, i) => l.startsWith('diff --git ') || (l.startsWith('--- ') && (lines[i + 1] ?? '').startsWith('+++ ')))) return 'unified';
  return null;
}

const DIFF_GIT = /^diff --git a\/([^ \t]+) b\/([^ \t]+)[ \t]*$/;
const HUNK_HEAD = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

interface Hunk {
  a: number;
  entries: BEntry[];
}

interface USection {
  oldPath: string | null;
  newPath: string | null;
  isCreate: boolean;
  isDelete: boolean;
  hunks: Hunk[];
}

/** The path after `--- ` / `+++ `: up to the first tab, spaces removed, a/ or b/ stripped. */
function dashPath(line: string): string {
  let p = line.slice(4).split('\t')[0]!.trim();
  if (p.startsWith('a/') || p.startsWith('b/')) p = p.slice(2);
  return p;
}

/** Apply a section's hunks in order to a file's lines, updating its final break. */
function applyHunks(model: FModel, hunks: Hunk[], strict: boolean, path: string): void {
  let d = 0;
  for (const h of hunks) {
    const O = oldLinesOf(h.entries);
    const nCount = newCountOf(h.entries);
    const beforeLen = model.lines.length;
    if (O.length > 0) {
      const found = findTier(O, model.lines, strict);
      if (found === null) throw new Fail('no-match', path);
      const target = h.a - 1 + d;
      let best = found.occ[0]!;
      for (const o of found.occ) {
        if (Math.abs(o - target) < Math.abs(best - target)) best = o;
      }
      const ranToEnd = best + O.length === beforeLen;
      const rep = buildReplacement(model.lines, best, h.entries, found.t);
      model.lines = [...model.lines.slice(0, best), ...rep, ...model.lines.slice(best + O.length)];
      if (ranToEnd) model.fin = !noFinalBreak(h.entries);
      d += nCount - O.length;
    } else {
      const idx = Math.min(h.a + d, beforeLen);
      const ins = h.entries.filter((e) => e.k === '+').map((e) => e.text);
      model.lines = [...model.lines.slice(0, idx), ...ins, ...model.lines.slice(idx)];
      if (idx === beforeLen) model.fin = !noFinalBreak(h.entries);
      d += ins.length;
    }
  }
}

function sectionEdit(sec: USection, strict: boolean): { edit: Edit; move: [string, string] | null } {
  const oldP = sec.oldPath;
  const newP = sec.newPath;
  if ((oldP === null || sec.isCreate) && newP !== null && !sec.isDelete) {
    const p = newP;
    return {
      edit: (tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.exists(p)) throw new Fail('exists', p);
        const plus: string[] = [];
        for (const h of sec.hunks) for (const e of h.entries) if (e.k === '+') plus.push(e.text);
        let fin = true;
        outer: for (let hi = sec.hunks.length - 1; hi >= 0; hi--) {
          const es = sec.hunks[hi]!.entries;
          for (let i = es.length - 1; i >= 0; i--) {
            if (es[i]!.k === '+') {
              fin = !(es[i + 1] !== undefined && es[i + 1]!.k === '\\');
              break outer;
            }
          }
        }
        tree.now.set(p, plus.length === 0 ? '' : plus.join('\n') + (fin ? '\n' : ''));
      },
      move: null,
    };
  }
  if ((newP === null || sec.isDelete) && oldP !== null) {
    const p = oldP;
    return {
      edit: (tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.get(p) === null) throw new Fail('missing', p);
        tree.now.set(p, null);
      },
      move: null,
    };
  }
  if (oldP !== null && newP !== null && oldP !== newP) {
    return {
      edit: (tree) => {
        if (!safe(oldP)) throw new Fail('unsafe', oldP);
        if (!safe(newP)) throw new Fail('unsafe', newP);
        const before = tree.get(oldP);
        if (before === null) throw new Fail('missing', oldP);
        if (tree.exists(newP)) throw new Fail('exists', newP);
        const model = parseFile(before);
        applyHunks(model, sec.hunks, strict, oldP);
        tree.now.set(newP, serializeFile(model));
        tree.now.set(oldP, null);
      },
      move: [oldP, newP],
    };
  }
  const p = oldP ?? '';
  return {
    edit: (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      const before = tree.get(p);
      if (before === null) throw new Fail('missing', p);
      const model = parseFile(before);
      applyHunks(model, sec.hunks, strict, p);
      tree.now.set(p, serializeFile(model));
    },
    move: null,
  };
}

function parseUnified(lines: string[], strict: boolean): Parsed {
  const sections: USection[] = [];
  const n = lines.length;
  const isSectionStart = (j: number): boolean => {
    if (j >= n) return false;
    if (lines[j]!.startsWith('diff --git ')) return true;
    return lines[j]!.startsWith('--- ') && j + 1 < n && lines[j + 1]!.startsWith('+++ ');
  };
  let i = 0;
  while (i < n) {
    if (!isSectionStart(i)) {
      if (lines[i]!.startsWith('@@')) throw new Exit2(`error: parse ${i + 1}`);
      i += 1;
      continue;
    }
    const sec: USection = { oldPath: null, newPath: null, isCreate: false, isDelete: false, hunks: [] };
    let diffOld: string | null = null;
    let diffNew: string | null = null;
    let renOld: string | null = null;
    let renNew: string | null = null;
    let dashOld: string | null = null;
    let dashNew: string | null = null;
    let haveDiff = false;
    let haveDash = false;
    while (i < n) {
      const l = lines[i]!;
      if (l.startsWith('diff --git ')) {
        if (sec.hunks.length > 0 || haveDiff || haveDash) break;
        const m = DIFF_GIT.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        diffOld = m[1]!;
        diffNew = m[2]!;
        haveDiff = true;
        i += 1;
      } else if (l.startsWith('--- ')) {
        if (sec.hunks.length > 0 || haveDash) break;
        if (i + 1 >= n || !lines[i + 1]!.startsWith('+++ ')) throw new Exit2(`error: parse ${i + 2}`);
        dashOld = dashPath(l);
        dashNew = dashPath(lines[i + 1]!);
        haveDash = true;
        i += 2;
      } else if (l.startsWith('+++ ')) {
        i += 1;
      } else if (l.startsWith('rename from ') && sec.hunks.length === 0) {
        renOld = l.slice('rename from '.length).trim();
        i += 1;
      } else if (l.startsWith('rename to ') && sec.hunks.length === 0) {
        renNew = l.slice('rename to '.length).trim();
        i += 1;
      } else if (l.startsWith('new file mode') && sec.hunks.length === 0) {
        sec.isCreate = true;
        i += 1;
      } else if (l.startsWith('deleted file mode') && sec.hunks.length === 0) {
        sec.isDelete = true;
        i += 1;
      } else if (l.startsWith('@@')) {
        const m = HUNK_HEAD.exec(l);
        if (m === null) throw new Exit2(`error: parse ${i + 1}`);
        const a = Number(m[1]);
        i += 1;
        const entries: BEntry[] = [];
        while (i < n) {
          const b = lines[i]!;
          if (b.startsWith('--- ') && i + 1 < n && lines[i + 1]!.startsWith('+++ ')) break;
          if (b === '') {
            entries.push({ k: ' ', text: '' });
            i += 1;
          } else if (b[0] === ' ') {
            entries.push({ k: ' ', text: b.slice(1) });
            i += 1;
          } else if (b[0] === '-') {
            entries.push({ k: '-', text: b.slice(1) });
            i += 1;
          } else if (b[0] === '+') {
            entries.push({ k: '+', text: b.slice(1) });
            i += 1;
          } else if (b[0] === '\\') {
            entries.push({ k: '\\', text: b.slice(1) });
            i += 1;
          } else break;
        }
        while (entries.length > 0) {
          const last = entries[entries.length - 1]!;
          if (last.k === ' ' && last.text === '') entries.pop();
          else break;
        }
        sec.hunks.push({ a, entries });
      } else {
        i += 1;
      }
    }
    const oldRaw = dashOld ?? renOld ?? diffOld;
    const newRaw = dashNew ?? renNew ?? diffNew;
    sec.oldPath = oldRaw === null || oldRaw === '/dev/null' ? null : oldRaw;
    sec.newPath = newRaw === null || newRaw === '/dev/null' ? null : newRaw;
    sections.push(sec);
  }
  if (sections.length === 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  const moves: Array<[string, string]> = [];
  for (const sec of sections) {
    const r = sectionEdit(sec, strict);
    edits.push(r.edit);
    if (r.move !== null) moves.push(r.move);
  }
  return { edits, moves };
}

function parseSearchReplace(lines: string[], strict: boolean): Parsed {
  const edits: Edit[] = [];
  const n = lines.length;
  let i = 0;
  let prevEnd = 0;
  let prevPath: string | null = null;
  while (i < n) {
    let s = -1;
    for (let j = i; j < n; j++) {
      if (lines[j]!.trimEnd() === '<<<<<<< SEARCH') {
        s = j;
        break;
      }
    }
    if (s < 0) break;
    let eq = -1;
    for (let j = s + 1; j < n; j++) {
      const t = lines[j]!.trimEnd();
      if (t === '=======') {
        eq = j;
        break;
      }
      if (t === '>>>>>>> REPLACE') break;
    }
    if (eq < 0) throw new Exit2(`error: parse ${s + 1}`);
    let rep = -1;
    for (let j = eq + 1; j < n; j++) {
      if (lines[j]!.trimEnd() === '>>>>>>> REPLACE') {
        rep = j;
        break;
      }
    }
    if (rep < 0) throw new Exit2(`error: parse ${s + 1}`);
    let path: string | null = null;
    for (let j = s - 1; j >= prevEnd; j--) {
      const l = lines[j]!;
      if (blank(l)) continue;
      if (l.trim().startsWith('```')) continue;
      path = l.trim();
      break;
    }
    if (path === null) path = prevPath;
    if (path === null) throw new Exit2(`error: parse ${s + 1}`);
    const oldLines = lines.slice(s + 1, eq);
    const newLines = lines.slice(eq + 1, rep);
    const p = path;
    prevPath = p;
    prevEnd = rep + 1;
    i = rep + 1;
    if (oldLines.length === 0) {
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        if (tree.exists(p)) throw new Fail('exists', p);
        tree.now.set(p, newLines.length === 0 ? '' : newLines.join('\n') + '\n');
      });
    } else {
      const entries: BEntry[] = [
        ...oldLines.map((t): BEntry => ({ k: '-', text: t })),
        ...newLines.map((t): BEntry => ({ k: '+', text: t })),
      ];
      edits.push((tree) => {
        if (!safe(p)) throw new Fail('unsafe', p);
        const before = tree.get(p);
        if (before === null) throw new Fail('missing', p);
        const model = parseFile(before);
        const found = findTier(oldLines, model.lines, strict);
        if (found === null) throw new Fail('no-match', p);
        if (found.occ.length > 1) throw new Fail('ambiguous', p);
        const at = found.occ[0]!;
        const rep2 = buildReplacement(model.lines, at, entries, found.t);
        model.lines = [...model.lines.slice(0, at), ...rep2, ...model.lines.slice(at + oldLines.length)];
        tree.now.set(p, serializeFile(model));
      });
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return { edits, moves: [] };
}

function parseV4a(lines: string[], strict: boolean): Parsed {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  if (lines[first]!.trim() !== '*** Begin Patch') throw new Exit2(`error: parse ${first + 1}`);
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!blank(lines[i]!)) {
      last = i;
      break;
    }
  }
  if (lines[last]!.trim() !== '*** End Patch') throw new Exit2(`error: parse ${lines.length + 1}`);
  const edits: Edit[] = [];
  const moves: Array<[string, string]> = [];
  const isSectionStart = (j: number): boolean => {
    if (j >= last) return false;
    const l = lines[j]!;
    return l.startsWith('*** Add File: ') || l.startsWith('*** Delete File: ') || l.startsWith('*** Update File: ');
  };
  let i = first + 1;
  while (i < last) {
    if (blank(lines[i]!)) {
      i += 1;
      continue;
    }
    if (!isSectionStart(i)) throw new Exit2(`error: parse ${i + 1}`);
    const l = lines[i]!;
    const kind = l.startsWith('*** Add File: ') ? 'add' : l.startsWith('*** Delete File: ') ? 'delete' : 'update';
    const p = l.slice(l.indexOf(':') + 1).trim();
    if (kind === 'add') {
      const rawLines: string[] = [];
      i += 1;
      while (i < last && !isSectionStart(i)) {
        const b = lines[i]!;
        if (b.startsWith('+') || b === '') {
          rawLines.push(b);
          i += 1;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      while (rawLines.length > 0 && rawLines[rawLines.length - 1] === '') rawLines.pop();
      const secLines = rawLines.map((b) => (b === '' ? '' : b.slice(1)));
      const pp = p;
      edits.push((tree) => {
        if (!safe(pp)) throw new Fail('unsafe', pp);
        if (tree.exists(pp)) throw new Fail('exists', pp);
        tree.now.set(pp, secLines.length === 0 ? '' : secLines.join('\n') + '\n');
      });
    } else if (kind === 'delete') {
      i += 1;
      while (i < last && !isSectionStart(i)) {
        if (blank(lines[i]!)) {
          i += 1;
          continue;
        }
        throw new Exit2(`error: parse ${i + 1}`);
      }
      const pp = p;
      edits.push((tree) => {
        if (!safe(pp)) throw new Fail('unsafe', pp);
        if (tree.get(pp) === null) throw new Fail('missing', pp);
        tree.now.set(pp, null);
      });
    } else {
      const secLine = i + 1;
      i += 1;
      let moveTo: string | null = null;
      let j = i;
      while (j < last && blank(lines[j]!)) j += 1;
      if (j < last && lines[j]!.startsWith('*** Move to: ')) {
        moveTo = lines[j]!.slice('*** Move to: '.length).trim();
        i = j + 1;
      }
      interface VChunk {
        anchor: string | null;
        entries: BEntry[];
        eof: boolean;
      }
      const chunks: VChunk[] = [];
      let cur: VChunk | null = null;
      let firstChunk = true;
      while (i < last && !isSectionStart(i)) {
        const b = lines[i]!;
        if (b.startsWith('@@')) {
          if (cur !== null) chunks.push(cur);
          cur = { anchor: b.slice(2).trim(), entries: [], eof: false };
          firstChunk = false;
          i += 1;
        } else if (b === '*** End of File') {
          if (cur === null) cur = { anchor: null, entries: [], eof: true };
          else cur.eof = true;
          chunks.push(cur);
          cur = null;
          firstChunk = false;
          i += 1;
        } else if (b === '' || b[0] === ' ' || b[0] === '-' || b[0] === '+') {
          if (cur === null) {
            if (!firstChunk) throw new Exit2(`error: parse ${i + 1}`);
            cur = { anchor: null, entries: [], eof: false };
          }
          if (b === '') cur.entries.push({ k: ' ', text: '' });
          else if (b[0] === ' ') cur.entries.push({ k: ' ', text: b.slice(1) });
          else if (b[0] === '-') cur.entries.push({ k: '-', text: b.slice(1) });
          else cur.entries.push({ k: '+', text: b.slice(1) });
          i += 1;
        } else throw new Exit2(`error: parse ${i + 1}`);
      }
      if (cur !== null) {
        while (cur.entries.length > 0) {
          const lastE = cur.entries[cur.entries.length - 1]!;
          if (lastE.k === ' ' && lastE.text.trim() === '') cur.entries.pop();
          else break;
        }
        chunks.push(cur);
      }
      if (chunks.length === 0 && moveTo === null) throw new Exit2(`error: parse ${secLine}`);
      const pp = p;
      const mt = moveTo;
      const chs = chunks;
      edits.push((tree) => {
        if (!safe(pp)) throw new Fail('unsafe', pp);
        if (mt !== null && !safe(mt)) throw new Fail('unsafe', mt);
        const before = tree.get(pp);
        if (before === null) throw new Fail('missing', pp);
        if (mt !== null && tree.exists(mt)) throw new Fail('exists', mt);
        const model = parseFile(before);
        let cursor = 0;
        for (const ch of chs) {
          if (ch.anchor !== null && ch.anchor !== '') {
            let foundLine = -1;
            for (const t of strict ? [0] : [0, 1, 2]) {
              for (let k = cursor; k < model.lines.length; k++) {
                if (tierEq(ch.anchor, model.lines[k]!, t)) {
                  foundLine = k;
                  break;
                }
              }
              if (foundLine >= 0) break;
            }
            if (foundLine < 0) throw new Fail('no-match', pp);
            cursor = foundLine + 1;
          }
          const O = oldLinesOf(ch.entries);
          if (O.length > 0) {
            const found = findTier(O, model.lines, strict, cursor);
            if (found === null) throw new Fail('no-match', pp);
            let at = -1;
            for (const o of found.occ) {
              if (ch.eof) {
                if (o + O.length === model.lines.length) {
                  at = o;
                  break;
                }
              } else {
                at = o;
                break;
              }
            }
            if (at < 0) throw new Fail('no-match', pp);
            const rep2 = buildReplacement(model.lines, at, ch.entries, found.t);
            model.lines = [...model.lines.slice(0, at), ...rep2, ...model.lines.slice(at + O.length)];
            cursor = at + rep2.length;
          } else {
            const ins = ch.entries.filter((e) => e.k === '+').map((e) => e.text);
            const idx = ch.eof ? model.lines.length : cursor;
            model.lines = [...model.lines.slice(0, idx), ...ins, ...model.lines.slice(idx)];
            cursor = idx + ins.length;
          }
        }
        const out = serializeFile(model);
        if (mt !== null) {
          tree.now.set(mt, out);
          tree.now.set(pp, null);
        } else {
          tree.now.set(pp, out);
        }
      });
      if (moveTo !== null) moves.push([p, moveTo]);
    }
  }
  if (edits.length === 0) throw new Exit2('error: parse 1');
  return { edits, moves };
}

/** One JSON edit object (SPEC.md section 9), or null when it is not one. */
function jsonEdit(v: unknown): Edit | null {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const p = o.path;
  if (typeof p !== 'string') return null;
  const exists = (tree: Tree): string => {
    if (!safe(p)) throw new Fail('unsafe', p);
    const t = tree.get(p);
    if (t === null) throw new Fail('missing', p);
    return t;
  };
  if (o.command === 'create' && typeof o.file_text === 'string') {
    const text = o.file_text;
    return (tree) => {
      if (!safe(p)) throw new Fail('unsafe', p);
      if (tree.exists(p)) throw new Fail('exists', p);
      tree.now.set(p, text);
    };
  }
  if (o.command === 'str_replace' && typeof o.old_str === 'string' && o.old_str !== '' && (o.new_str === undefined || typeof o.new_str === 'string')) {
    const oldStr = o.old_str;
    const newStr = (o.new_str as string | undefined) ?? '';
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const crlf = nl > 0 && before[nl - 1] === '\r';
      const lf = (s: string): string => (crlf ? s.replaceAll('\r\n', '\n') : s);
      const t = lf(before);
      const old = lf(oldStr);
      let count = 0;
      for (let k = t.indexOf(old); k >= 0; k = t.indexOf(old, k + 1)) count += 1;
      if (count === 0) throw new Fail('no-match', p);
      if (count > 1) throw new Fail('ambiguous', p);
      const at = t.indexOf(old);
      const out = t.slice(0, at) + lf(newStr) + t.slice(at + old.length);
      tree.now.set(p, crlf ? out.replaceAll('\n', '\r\n') : out);
    };
  }
  if (o.command === 'insert' && typeof o.insert_line === 'number' && Number.isInteger(o.insert_line) && typeof o.new_str === 'string') {
    const line = o.insert_line;
    const add = patchLines(o.new_str);
    return (tree) => {
      const before = exists(tree);
      const nl = before.indexOf('\n');
      const br = nl > 0 && before[nl - 1] === '\r' ? '\r\n' : '\n';
      const lines = before === '' ? [] : before.split(br);
      const final = before !== '' && before.endsWith(br);
      if (final) lines.pop();
      if (line < 0 || line > lines.length) throw new Fail('no-match', p);
      lines.splice(line, 0, ...add);
      tree.now.set(p, lines.length === 0 ? '' : lines.join(br) + (final ? br : ''));
    };
  }
  return null;
}

function jsonEdits(text: string, lines: string[]): Edit[] {
  const first = lines.findIndex((l) => !blank(l));
  if (first < 0) throw new Exit2('error: parse 1');
  const edits: Edit[] = [];
  if (lines[first]!.trimStart().startsWith('[')) {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new Exit2(`error: parse ${first + 1}`);
    }
    if (!Array.isArray(v)) throw new Exit2(`error: parse ${first + 1}`);
    for (const x of v) {
      const e = jsonEdit(x);
      if (e === null) throw new Exit2(`error: parse ${first + 1}`);
      edits.push(e);
    }
    return edits;
  }
  lines.forEach((l, i) => {
    if (blank(l)) return;
    let e: Edit | null = null;
    try {
      e = jsonEdit(JSON.parse(l));
    } catch {
      e = null;
    }
    if (e === null) throw new Exit2(`error: parse ${i + 1}`);
    edits.push(e);
  });
  return edits;
}

function run(args: string[]): { code: number; out: string[] } {
  let format: string | null = null;
  let check = false;
  let strict = false;
  const pos: string[] = [];
  let ended = false;
  for (const a of args) {
    if (!ended && a === '--') ended = true;
    else if (!ended && a.startsWith('-') && a !== '-') {
      if (a.startsWith('--format=') && format === null && FORMATS.includes(a.slice(9))) format = a.slice(9);
      else if (a === '--check' && !check) check = true;
      else if (a === '--strict' && !strict) strict = true;
      else return { code: 2, out: ['error: usage'] };
    } else pos.push(a);
  }
  if (pos.length > 1) return { code: 2, out: ['error: usage'] };
  const file = pos.length === 0 || pos[0] === '-' ? null : pos[0]!;
  let text = '';
  try {
    text = readFileSync(file ?? 0, 'utf8');
  } catch {
    if (file !== null) return { code: 2, out: ['error: no-patch'] };
  }
  const lines = patchLines(text);
  const kind = format === null || format === 'auto' ? detect(lines) : format;
  if (kind === null) return { code: 2, out: ['error: format'] };
  let parsed: Parsed;
  try {
    parsed =
      kind === 'json'
        ? { edits: jsonEdits(text, lines), moves: [] }
        : kind === 'unified'
          ? parseUnified(lines, strict)
          : kind === 'search-replace'
            ? parseSearchReplace(lines, strict)
            : parseV4a(lines, strict);
    if (parsed.edits.length === 0) throw new Exit2('error: parse 1');
  } catch (e) {
    if (e instanceof Exit2) return { code: 2, out: [e.line] };
    throw e;
  }
  const edits = parsed.edits;
  const tree = new Tree();
  const fails: Fail[] = [];
  for (const edit of edits) {
    const before = new Map(tree.now);
    try {
      edit(tree);
    } catch (e) {
      if (!(e instanceof Fail)) throw e;
      tree.now.clear();
      for (const [k, v] of before) tree.now.set(k, v);
      fails.push(e);
    }
  }
  if (fails.length > 0) return { code: 1, out: [...fails.map((f) => `error: ${f.code} ${f.path}`), `failed: ${fails.length} of ${edits.length} edits`] };
  const outRows: Array<{ key: string; text: string }> = [];
  const rUsed = new Set<string>();
  for (const [oldP, newP] of parsed.moves) {
    const oldWas = tree.original(oldP);
    const newWas = tree.original(newP);
    if (oldWas !== null && newWas === null && tree.now.get(oldP) === null && tree.now.has(newP) && tree.now.get(newP) !== null) {
      outRows.push({ key: newP, text: `R ${oldP} -> ${newP}` });
      rUsed.add(oldP);
      rUsed.add(newP);
    }
  }
  for (const p of [...tree.now.keys()]) {
    if (rUsed.has(p)) continue;
    const was = tree.original(p);
    const now = tree.now.get(p)!;
    if (was === now) continue;
    outRows.push({ key: p, text: `${was === null ? 'A' : now === null ? 'D' : 'M'} ${p}` });
  }
  outRows.sort((a, b) => Buffer.compare(Buffer.from(a.key), Buffer.from(b.key)));
  const rows = outRows.map((r) => r.text);
  if (!check) {
    for (const p of [...tree.now.keys()].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))) {
      const now = tree.now.get(p)!;
      if (now === null) rmSync(p, { force: true });
      else {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, now);
      }
    }
  }
  return { code: 0, out: [...rows, `ok: ${rows.length} ${rows.length === 1 ? 'file' : 'files'}`] };
}


const trialEnv = process.env.MAKEFUN_ENV_URL;
if (trialEnv !== undefined && trialEnv !== '') {
  // A trial: the kit's runner reads the checks from the env and runs this file on each one, without this variable.
  const { runTrial } = await import('./runner.ts');
  await runTrial(trialEnv);
} else {
  const r = run(process.argv.slice(2));
  writeSync(1, r.out.map((l) => `${l}\n`).join(''));
  process.exitCode = r.code;
}

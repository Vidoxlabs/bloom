import { createHash, randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, realpathSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { BloomError } from './errors.mjs';

export const digest = text => createHash('sha256').update(text).digest('hex');
const fields = 'id, title, author, sha256, created_at, filename, folder, COALESCE(root, id) AS root, COALESCE(revision, 1) AS revision';
const visible = alias => `(${alias}.private_epoch IS NULL OR (${alias}.team=? AND ${alias}.private_epoch=?))`;
const segment = /^[\p{L}\p{N}][\p{L}\p{N} ._-]{0,39}$/u;
export function folderOf(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string') throw new BloomError('FOLDER_INVALID', 'Use a folder name such as Research or Research/Sources.', 400);
  const parts = value.trim().split('/').map(part => part.trim());
  if (value.trim().length > 80 || parts.length > 3 || parts.some(part => !segment.test(part) || part === '.' || part === '..')) {
    throw new BloomError('FOLDER_INVALID', 'Use up to three folder names of letters, numbers, spaces, dots, hyphens or underscores.', 400);
  }
  return parts.join('/');
}
const stop = new Set('the and for with that this from into your our are was were will have has not but you they them their its about what when which who how all any can should would could use using'.split(' '));
const words = text => new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter(word => word.length > 2 && !stop.has(word)));
const overlap = (a, b) => { let n = 0; for (const word of a) if (b.has(word)) n++; return n; };
// A portable reading of Memorix floatation (synaptic.score.v1) without embeddings or a graph:
// lexical relevance stands in for vector similarity, and the weights keep their published order.
export function rank(notes, query, { limit = 8, chars = 2000 } = {}) {
  const q = words(query), day = 86_400_000;
  const scored = notes.map(note => {
    const w = words(note.text);
    const relevance = q.size && w.size ? overlap(q, w) / Math.sqrt(q.size * w.size) : 0;
    const authority = note.source === 'owner' ? 1 : 0.8;
    const mass = Math.log(1 + Math.min(1000, note.uses)) / Math.log(1001);
    const fresh = 0.5 ** ((Date.now() - Date.parse(note.used_at ?? note.created_at)) / day / 30);
    const score = 0.45 * Math.min(1, relevance) + 0.15 * authority + 0.08 + 0.07 * mass + 0.05 * fresh + 0.05 * note.useful;
    return { note, words: w, relevance, score };
  }).filter(entry => entry.note.kind === 'rule' || entry.relevance > 0)
    .sort((a, b) => (b.note.kind === 'rule') - (a.note.kind === 'rule') || b.score - a.score);
  const chosen = [];
  let used = 0;
  for (const entry of scored) {
    if (chosen.length >= limit || used + entry.note.text.length > chars) continue;
    // Anti-redundancy: skip near-duplicates of a note already admitted.
    if (chosen.some(other => overlap(other.words, entry.words) / (new Set([...other.words, ...entry.words]).size || 1) >= 0.85)) continue;
    chosen.push(entry);
    used += entry.note.text.length;
  }
  return chosen.map(({ note, score }) => ({ id: note.id, text: note.text, kind: note.kind, shared: note.shared, score: Math.round(score * 100) / 100 }));
}
const unavailable = () => new BloomError('FILE_UNAVAILABLE', 'This file is unavailable to the team.', 404);

export class TeamStore {
  constructor(store, directory) {
    this.store = store;
    this.db = store.db;
    const desktop = join(directory, 'Desktop');
    mkdirSync(desktop, { recursive: true, mode: 0o700 });
    this.desktop = realpathSync(desktop);
    this.cache = new Map();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS teams (
        id TEXT PRIMARY KEY REFERENCES sessions, name TEXT NOT NULL, charter TEXT NOT NULL,
        call_limit INTEGER NOT NULL, token_limit INTEGER, epoch INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS members (
        team TEXT NOT NULL REFERENCES teams, name TEXT COLLATE NOCASE NOT NULL,
        charter TEXT NOT NULL, voice TEXT NOT NULL, stage TEXT NOT NULL,
        PRIMARY KEY(team, name));
      CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY, team TEXT NOT NULL REFERENCES teams, text TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS desktop_files (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, author TEXT NOT NULL, team TEXT NOT NULL REFERENCES teams,
        private_epoch INTEGER, sha256 TEXT NOT NULL, filename TEXT NOT NULL UNIQUE,
        created_at TEXT NOT NULL, source_url TEXT);
      CREATE TABLE IF NOT EXISTS personas (
        id TEXT PRIMARY KEY, name TEXT COLLATE NOCASE NOT NULL UNIQUE, charter TEXT NOT NULL, voice TEXT NOT NULL,
        stage TEXT NOT NULL, model TEXT, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, team TEXT REFERENCES teams, text TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL,
        source TEXT NOT NULL, source_file TEXT, epoch INTEGER, supersedes TEXT, uses INTEGER NOT NULL DEFAULT 0,
        useful REAL NOT NULL DEFAULT 0, created_at TEXT NOT NULL, used_at TEXT);
      CREATE TABLE IF NOT EXISTS file_links (
        child TEXT NOT NULL REFERENCES desktop_files, parent TEXT NOT NULL REFERENCES desktop_files,
        PRIMARY KEY(child,parent));
    `);
    const columns = new Set(this.db.prepare('PRAGMA table_info(desktop_files)').all().map(column => column.name));
    for (const [name, type] of [['root', 'TEXT'], ['revision', 'INTEGER'], ['folder', 'TEXT']]) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE desktop_files ADD COLUMN ${name} ${type}`);
    }
    if (!this.db.prepare('PRAGMA table_info(members)').all().some(column => column.name === 'model')) {
      this.db.exec('ALTER TABLE members ADD COLUMN model TEXT');
    }
    // Notes saved before 0.5.0 become owner rules: they keep applying to every call, as they always did.
    this.store.transaction(() => {
      this.db.prepare(`INSERT OR IGNORE INTO memories (id,team,text,kind,status,source,created_at)
        SELECT id,team,text,'rule','kept','owner',? FROM notes`).run(new Date().toISOString());
      this.db.exec('DELETE FROM notes');
    });
  }

  others(id) { return this.db.prepare('SELECT id,name,charter FROM teams WHERE id<>? ORDER BY name').all(id); }
  team(id) { return this.db.prepare('SELECT * FROM teams WHERE id=?').get(id); }
  require(id) {
    const team = this.team(id);
    if (!team) throw new BloomError('TEAM_NOT_FOUND', 'Team not found.', 404);
    return team;
  }
  create(id, name, charter, calls, tokens) {
    this.db.prepare('INSERT INTO teams (id,name,charter,call_limit,token_limit) VALUES (?,?,?,?,?)')
      .run(id, name, charter, calls, tokens);
    this.store.db.prepare('UPDATE sessions SET title=? WHERE id=?').run(name, id);
  }
  members(id) { return this.db.prepare('SELECT name,charter,voice,stage,model FROM members WHERE team=? ORDER BY rowid').all(id); }
  upsert(id, member) {
    this.db.prepare(`INSERT INTO members (team,name,charter,voice,stage,model) VALUES (?,?,?,?,?,?) ON CONFLICT(team,name) DO UPDATE
      SET charter=excluded.charter,voice=excluded.voice,stage=excluded.stage,model=excluded.model`)
      .run(id, member.name, member.charter, member.voice, member.stage, member.model ?? null);
  }
  personas() { return this.db.prepare('SELECT id,name,charter,voice,stage,model,created_at FROM personas ORDER BY name COLLATE NOCASE').all(); }
  persona(personaId) {
    const persona = this.db.prepare('SELECT id,name,charter,voice,stage,model,created_at FROM personas WHERE id=?').get(personaId);
    if (!persona) throw new BloomError('PERSONA_NOT_FOUND', 'Persona not found.', 404);
    return persona;
  }
  savePersona(persona, personaId = null) {
    const clash = this.db.prepare('SELECT id FROM personas WHERE name=? COLLATE NOCASE').get(persona.name);
    if (clash && clash.id !== personaId) throw new BloomError('PERSONA_EXISTS', 'A persona with this name is already in the library.', 409);
    if (personaId) {
      this.persona(personaId);
      this.db.prepare('UPDATE personas SET name=?,charter=?,voice=?,stage=?,model=? WHERE id=?')
        .run(persona.name, persona.charter, persona.voice, persona.stage, persona.model, personaId);
      return this.persona(personaId);
    }
    if (this.db.prepare('SELECT COUNT(*) AS n FROM personas').get().n >= 64) {
      throw new BloomError('PERSONA_LIMIT', 'The library holds 64 personas. Delete one to add another.', 409);
    }
    const id = randomUUID();
    this.db.prepare('INSERT INTO personas VALUES (?,?,?,?,?,?,?)')
      .run(id, persona.name, persona.charter, persona.voice, persona.stage, persona.model, new Date().toISOString());
    return this.persona(id);
  }
  deletePersona(personaId) {
    if (!this.db.prepare('DELETE FROM personas WHERE id=?').run(personaId).changes) throw new BloomError('PERSONA_NOT_FOUND', 'Persona not found.', 404);
  }
  // Kept memories this team may use: its own, plus notes shared with every team.
  notes(id) {
    return this.db.prepare(`SELECT id,text,kind,source,supersedes,uses,useful,created_at,used_at,(team IS NULL) AS shared FROM memories
      WHERE status='kept' AND (team=? OR team IS NULL) ORDER BY team IS NULL, rowid`).all(id).map(row => ({ ...row, shared: Boolean(row.shared) }));
  }
  // Agent suggestions stay unconfirmed and are never recalled until the owner keeps them.
  proposals(id) {
    const { epoch } = this.require(id);
    return this.db.prepare(`SELECT id,text,source,source_file FROM memories WHERE status='proposed' AND team=? AND epoch=? ORDER BY rowid`).all(id, epoch);
  }
  addNote(id, { text, kind = 'rule', shared = false, source = 'owner', supersedes = null }) {
    this.require(id);
    const scope = shared ? null : id;
    const count = this.db.prepare(`SELECT count(*) AS n FROM memories WHERE status='kept' AND team IS ?`).get(scope).n;
    if (count >= 24) throw new BloomError('NOTE_LIMIT', shared ? 'There are 24 shared notes. Forget one to add another.' : 'This team has 24 saved notes. Forget a note to add another.', 409);
    const note = { id: randomUUID(), text, kind, shared: Boolean(shared), source, supersedes };
    this.db.prepare(`INSERT INTO memories (id,team,text,kind,status,source,supersedes,created_at) VALUES (?,?,?,?,'kept',?,?,?)`)
      .run(note.id, scope, text, kind, source, supersedes, new Date().toISOString());
    this.cache.clear();
    return note;
  }
  propose(id, { text, source, sourceFile, epoch }) {
    if (this.db.prepare(`SELECT 1 FROM memories WHERE (team=? OR team IS NULL) AND lower(text)=lower(?) AND (status='kept' OR epoch=?)`).get(id, text, epoch)) return;
    this.store.transaction(() => {
      this.db.prepare(`INSERT INTO memories (id,team,text,kind,status,source,source_file,epoch,created_at) VALUES (?,?,?,'fact','proposed',?,?,?,?)`)
        .run(randomUUID(), id, text, source, sourceFile, epoch, new Date().toISOString());
      // Keep the twelve newest suggestions.
      this.db.prepare(`DELETE FROM memories WHERE status='proposed' AND team=? AND id NOT IN
        (SELECT id FROM memories WHERE status='proposed' AND team=? ORDER BY rowid DESC LIMIT 12)`).run(id, id);
    });
  }
  memory(id, noteId) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id=? AND (team=? OR team IS NULL)').get(noteId, id);
    if (!row) throw new BloomError('NOTE_MISSING', 'Team note not found.', 404);
    return row;
  }
  keep(id, noteId) {
    const row = this.memory(id, noteId);
    if (row.status !== 'proposed' || row.epoch !== this.require(id).epoch) throw new BloomError('NOTE_MISSING', 'This suggestion is no longer available.', 404);
    if (this.db.prepare(`SELECT count(*) AS n FROM memories WHERE status='kept' AND team=?`).get(id).n >= 24) {
      throw new BloomError('NOTE_LIMIT', 'This team has 24 saved notes. Forget a note to add another.', 409);
    }
    this.db.prepare(`UPDATE memories SET status='kept', created_at=? WHERE id=?`).run(new Date().toISOString(), noteId);
    this.cache.clear();
    return this.notes(id).find(note => note.id === noteId);
  }
  dismiss(id, noteId) {
    const row = this.memory(id, noteId);
    if (row.status !== 'proposed') throw new BloomError('NOTE_MISSING', 'This suggestion is no longer available.', 404);
    this.db.prepare('DELETE FROM memories WHERE id=?').run(noteId);
  }
  // Forget and Correct withdraw everything derived from a kept note: the epoch moves for every team that could use it.
  forget(id, noteId, replacement = null) {
    const result = this.store.transaction(() => {
      const row = this.memory(id, noteId);
      if (row.status !== 'kept') throw new BloomError('NOTE_MISSING', 'Team note not found.', 404);
      this.db.prepare('DELETE FROM memories WHERE id=?').run(noteId);
      const teams = row.team === null ? this.db.prepare('SELECT id FROM teams').all().map(t => t.id) : [id];
      for (const team of teams) {
        this.db.prepare('UPDATE teams SET epoch=epoch+1 WHERE id=?').run(team);
        this.db.prepare(`DELETE FROM memories WHERE status='proposed' AND team=?`).run(team);
      }
      const note = replacement ? this.addNote(id, { text: replacement, kind: row.kind, shared: row.team === null, source: 'owner', supersedes: noteId }) : null;
      return { teams, note };
    });
    this.cache.clear();
    return result;
  }
  // Tri-Cluster in one process: SQLite is the record, this TTL cache holds the hot set, ranking runs per call.
  recall(id, query = '') {
    const { epoch } = this.require(id);
    const cached = this.cache.get(id);
    const hit = cached?.epoch === epoch && cached.expires > Date.now();
    const notes = hit ? cached.notes : this.notes(id);
    if (!hit) {
      if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value);
      this.cache.set(id, { notes, epoch, expires: Date.now() + 60_000 });
    }
    return { notes: rank(notes, query), considered: notes.length, epoch, hit };
  }
  // Every admitted note gains mass; notes behind an approved review gain usefulness.
  used(ids, { useful = false } = {}) {
    const now = new Date().toISOString();
    for (const id of ids) {
      if (useful) this.db.prepare('UPDATE memories SET useful=MIN(1, useful+0.08) WHERE id=?').run(id);
      else this.db.prepare('UPDATE memories SET uses=uses+1, used_at=? WHERE id=?').run(now, id);
    }
    for (const entry of this.cache.values()) for (const note of entry.notes) {
      if (!ids.includes(note.id)) continue;
      if (useful) note.useful = Math.min(1, note.useful + 0.08);
      else { note.uses++; note.used_at = now; }
    }
  }
  files(id) {
    const team = this.require(id);
    // One row per revision chain: the newest revision this team may see.
    return this.db.prepare(`SELECT ${fields},source_url,(private_epoch IS NULL) AS shareable FROM desktop_files f WHERE ${visible('f')}
      AND NOT EXISTS (SELECT 1 FROM desktop_files g WHERE COALESCE(g.root, g.id)=COALESCE(f.root, f.id)
        AND COALESCE(g.revision, 1)>COALESCE(f.revision, 1) AND ${visible('g')})
      ORDER BY f.rowid DESC LIMIT 100`).all(id, team.epoch, id, team.epoch);
  }
  history(id, fileId) {
    const team = this.require(id);
    return this.db.prepare(`SELECT id, title, author, created_at, folder, COALESCE(revision, 1) AS revision FROM desktop_files f
      WHERE COALESCE(f.root, f.id)=(SELECT COALESCE(root, id) FROM desktop_files WHERE id=?) AND ${visible('f')}
      ORDER BY COALESCE(f.revision, 1)`).all(fileId, id, team.epoch);
  }
  read(id, fileId) {
    const team = this.require(id);
    const file = this.db.prepare('SELECT * FROM desktop_files WHERE id=?').get(fileId);
    if (!file || (file.private_epoch !== null && (file.team !== id || file.private_epoch !== team.epoch))) throw unavailable();
    let text;
    let fd;
    try {
      fd = openSync(join(this.desktop, file.filename), constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.size > 128_000) throw unavailable();
      text = readFileSync(fd, 'utf8');
    } catch { throw unavailable(); }
    finally { if (fd !== undefined) closeSync(fd); }
    if (digest(text) !== file.sha256) throw new BloomError('FILE_CHANGED', 'The desktop copy changed. Import the edited text as a new version.', 409);
    const parents = this.db.prepare('SELECT parent FROM file_links WHERE child=? ORDER BY rowid').all(file.id).map(x => x.parent);
    return { ...file, root: file.root ?? file.id, revision: file.revision ?? 1, text, parents };
  }
  write(id, { title, author, text, parents = [], privateEpoch = null, sourceUrl = null, revises = null, folder }) {
    const team = this.require(id);
    let root = null, revision = 1;
    if (revises) {
      const previous = this.read(id, revises);
      root = previous.root;
      revision = this.db.prepare('SELECT MAX(COALESCE(revision, 1)) AS n FROM desktop_files WHERE COALESCE(root, id)=?').get(root).n + 1;
      title ??= previous.title;
      if (folder === undefined) folder = previous.folder;
      sourceUrl ??= previous.source_url;
      parents = [revises, ...parents.filter(parent => parent !== revises)];
    }
    folder = folderOf(folder);
    const inputs = parents.map(parent => this.read(id, parent));
    if (inputs.some(input => input.private_epoch !== null)) privateEpoch = team.epoch;
    if (privateEpoch !== null && privateEpoch !== team.epoch) throw unavailable();
    const fileId = randomUUID();
    const slug = title.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 48) || 'Document';
    const filename = slug + '-' + fileId + '.md';
    root ??= fileId;
    const file = { id: fileId, title, author, filename, sha256: digest(text), created_at: new Date().toISOString(), folder, root, revision };
    const target = join(this.desktop, filename);
    const temp = target + '.tmp';
    try {
      writeFileSync(temp, text, { flag: 'wx', mode: 0o600 });
      renameSync(temp, target);
      this.store.transaction(() => {
        this.db.prepare(`INSERT INTO desktop_files (id,title,author,team,private_epoch,sha256,filename,created_at,source_url,root,revision,folder)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
          .run(fileId, title, author, id, privateEpoch, file.sha256, filename, file.created_at, sourceUrl, root, revision, folder);
        const edge = this.db.prepare('INSERT INTO file_links VALUES (?,?)');
        for (const parent of new Set(parents)) edge.run(fileId, parent);
      });
    } catch (error) {
      rmSync(temp, { force: true }); rmSync(target, { force: true });
      throw error;
    }
    return file;
  }
}

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
      CREATE TABLE IF NOT EXISTS file_links (
        child TEXT NOT NULL REFERENCES desktop_files, parent TEXT NOT NULL REFERENCES desktop_files,
        PRIMARY KEY(child,parent));
    `);
    const columns = new Set(this.db.prepare('PRAGMA table_info(desktop_files)').all().map(column => column.name));
    for (const [name, type] of [['root', 'TEXT'], ['revision', 'INTEGER'], ['folder', 'TEXT']]) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE desktop_files ADD COLUMN ${name} ${type}`);
    }
  }

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
  members(id) { return this.db.prepare('SELECT name,charter,voice,stage FROM members WHERE team=? ORDER BY rowid').all(id); }
  upsert(id, member) {
    this.db.prepare(`INSERT INTO members VALUES (?,?,?,?,?) ON CONFLICT(team,name) DO UPDATE
      SET charter=excluded.charter,voice=excluded.voice,stage=excluded.stage`)
      .run(id, member.name, member.charter, member.voice, member.stage);
  }
  notes(id) { return this.db.prepare('SELECT id,text FROM notes WHERE team=? ORDER BY rowid').all(id); }
  addNote(id, text) {
    this.require(id);
    if (this.notes(id).length >= 24) throw new BloomError('NOTE_LIMIT', 'This team has 24 saved notes. Forget a note to add another.', 409);
    const note = { id: randomUUID(), text };
    this.db.prepare('INSERT INTO notes VALUES (?,?,?)').run(note.id, id, text);
    this.cache.delete(id);
    return note;
  }
  forget(id, noteId) {
    this.store.transaction(() => {
      const result = this.db.prepare('DELETE FROM notes WHERE team=? AND id=?').run(id, noteId);
      if (!result.changes) throw new BloomError('NOTE_MISSING', 'Team note not found.', 404);
      this.db.prepare('UPDATE teams SET epoch=epoch+1 WHERE id=?').run(id);
    });
    this.cache.delete(id);
  }
  recall(id) {
    const { epoch } = this.require(id);
    const cached = this.cache.get(id);
    if (cached?.epoch === epoch && cached.expires > Date.now()) return { notes: cached.notes, epoch, hit: true };
    const notes = this.notes(id);
    if (this.cache.size >= 128) this.cache.delete(this.cache.keys().next().value);
    this.cache.set(id, { notes, epoch, expires: Date.now() + 60_000 });
    return { notes, epoch, hit: false };
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

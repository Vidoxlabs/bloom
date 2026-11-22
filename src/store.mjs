import { randomUUID } from 'node:crypto';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { BloomError } from './errors.mjs';

const now = () => new Date().toISOString();

export class Store {
  constructor(directory) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const path = join(directory, 'vibloom.sqlite');
    closeSync(openSync(path, 'a', 0o600));
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, workspace TEXT NOT NULL, adapter TEXT NOT NULL,
        title TEXT NOT NULL, native_id TEXT, model TEXT, updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS turns (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
        owner_pid INTEGER NOT NULL, status TEXT NOT NULL,
        started_at TEXT NOT NULL, finished_at TEXT
      );
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_turn
        ON turns(session_id) WHERE status = 'running';
      CREATE TABLE IF NOT EXISTS turn_requests (
        session_id TEXT NOT NULL REFERENCES sessions(id), request_id TEXT NOT NULL,
        fingerprint TEXT NOT NULL, turn_id TEXT NOT NULL REFERENCES turns(id), PRIMARY KEY(session_id, request_id));
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id),
        turn_id TEXT NOT NULL REFERENCES turns(id),
        type TEXT NOT NULL, data TEXT NOT NULL, at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_by_session ON events(session_id, seq);
    `);
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createSession({ id = randomUUID(), workspace, adapter, model }) {
    this.db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, NULL, ?, ?)')
      .run(id, workspace, adapter, 'New session', model, now());
    return this.getSession(id);
  }

  getSession(id) {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    if (!row) throw new BloomError('SESSION_NOT_FOUND', 'Session not found.', 404);
    return row;
  }

  listSessions() {
    return this.db.prepare(`
      SELECT sessions.*, EXISTS (
        SELECT 1 FROM turns WHERE turns.session_id = sessions.id AND status = 'running'
      ) AS active FROM sessions ORDER BY updated_at DESC
    `).all();
  }

  event(sessionId, turnId, type, data) {
    const at = now();
    const result = this.db.prepare('INSERT INTO events (session_id, turn_id, type, data, at) VALUES (?, ?, ?, ?, ?)')
      .run(sessionId, turnId, type, JSON.stringify(data), at);
    return { seq: Number(result.lastInsertRowid), turnId, type, data, at };
  }

  eventsAfter(sessionId, sequence) {
    return this.db.prepare('SELECT seq, turn_id, type, data, at FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT 100')
      .all(sessionId, sequence)
      .map(({ seq, turn_id: turnId, type, data, at }) => ({ seq, turnId, type, data: JSON.parse(data), at }));
  }

  replay(sessionId, key) {
    if (!key) return null;
    const old = this.db.prepare('SELECT fingerprint,turn_id FROM turn_requests WHERE session_id=? AND request_id=?').get(sessionId,key.id);
    if (old && old.fingerprint !== key.fingerprint) throw new BloomError('REQUEST_CONFLICT', 'This request ID already belongs to a different turn.', 409);
    return old?.turn_id ?? null;
  }

  startTurn(sessionId, prompt, model, key) {
    return this.transaction(() => {
      const replay = this.replay(sessionId,key);
      if (replay) return { id: replay, replay: true, events: [] };
      if (this.db.prepare("SELECT 1 FROM turns WHERE session_id = ? AND status = 'running'").get(sessionId)) {
        throw new BloomError('TURN_ACTIVE', 'This session already has an active turn.', 409);
      }
      const id = randomUUID();
      this.db.prepare("INSERT INTO turns VALUES (?, ?, ?, 'running', ?, NULL)")
        .run(id, sessionId, process.pid, now());
      if (key) this.db.prepare('INSERT INTO turn_requests VALUES (?,?,?,?)').run(sessionId,key.id,key.fingerprint,id);
      this.db.prepare("UPDATE sessions SET model=? WHERE id=? AND adapter='team'").run(model,sessionId);
      const heading = prompt.trim().replace(/\s+/g, ' ').slice(0, 72);
      const { title } = this.db.prepare(`
        UPDATE sessions SET title = CASE WHEN title = 'New session' THEN ? ELSE title END, updated_at = ?
        WHERE id = ? RETURNING title
      `).get(heading, now(), sessionId);
      return { id, events: [
        this.event(sessionId, id, 'user.message', { text: prompt }),
        this.event(sessionId, id, 'turn.started', { model, title }),
      ] };
    });
  }

  // A turn opened on another team's behalf: no user message, so the team shows it is busy answering.
  openTurn(sessionId) {
    return this.transaction(() => {
      if (this.db.prepare("SELECT 1 FROM turns WHERE session_id = ? AND status = 'running'").get(sessionId)) {
        throw new BloomError('TURN_ACTIVE', 'This session already has an active turn.', 409);
      }
      const id = randomUUID();
      this.db.prepare("INSERT INTO turns VALUES (?, ?, ?, 'running', ?, NULL)").run(id, sessionId, process.pid, now());
      const { model, title } = this.getSession(sessionId);
      return { id, events: [this.event(sessionId, id, 'turn.started', { model, title })] };
    });
  }

  bindSession(sessionId, nativeId, model) {
    this.db.prepare('UPDATE sessions SET native_id = ?, model = ?, updated_at = ? WHERE id = ?')
      .run(nativeId, model, now(), sessionId);
  }

  finishTurn(sessionId, turnId, status, details = {}) {
    return this.transaction(() => {
      const result = this.db.prepare("UPDATE turns SET status = ?, finished_at = ? WHERE id = ? AND session_id = ? AND status = 'running'")
        .run(status, now(), turnId, sessionId);
      if (!result.changes) return null;
      return this.event(sessionId, turnId, 'turn.finished', { status, ...details });
    });
  }

  recover() {
    for (const row of this.db.prepare("SELECT id, session_id, owner_pid FROM turns WHERE status = 'running'").all()) {
      try {
        process.kill(row.owner_pid, 0);
      } catch (error) {
        if (error.code === 'ESRCH') this.finishTurn(row.session_id, row.id, 'interrupted');
      }
    }
  }

  close() { this.db.close(); }
}

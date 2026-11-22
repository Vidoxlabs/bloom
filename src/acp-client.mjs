import { spawn } from 'node:child_process';
import { BloomError } from './errors.mjs';

const MAX_FRAME = 8 * 1024 * 1024;
const disconnected = () => new BloomError('AGENT_EXITED', 'The agent process exited before the turn ended.');

export class AcpClient {
  constructor({ command, args, cwd, onNotification, onRequest }) {
    this.process = spawn(command, args, { cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    this.nextId = 1;
    this.pending = new Map();
    this.buffer = '';
    this.failure = null;
    this.closed = false;
    this.onNotification = onNotification;
    this.onRequest = onRequest;
    this.process.stderr.resume();
    this.process.stdout.setEncoding('utf8');
    this.process.stdout.on('data', chunk => this.read(chunk));
    this.process.stdin.on('error', () => this.fail(disconnected()));
    this.process.on('error', error => this.fail(new BloomError(
      error.code === 'ENOENT' ? 'AGENT_MISSING' : 'AGENT_START_FAILED',
      error.code === 'ENOENT' ? 'OpenCode was not found on PATH.' : 'OpenCode could not be started.',
    )));
    this.process.on('close', () => this.fail(disconnected()));
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  write(message) {
    if (this.failure) throw this.failure;
    this.process.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  }

  request(method, params, timeoutMs = 20_000) {
    if (this.failure) return Promise.reject(this.failure);
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = timeoutMs ? setTimeout(() => {
        this.pending.delete(id);
        reject(new BloomError('AGENT_TIMEOUT', 'The agent timed out during ' + method + '.'));
      }, timeoutMs) : null;
      this.pending.set(id, { resolve, reject, timer, method });
      try {
        this.write({ id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params) { this.write({ method, params }); }

  read(chunk) {
    if (this.failure) return;
    this.buffer += chunk;
    try {
      let newline;
      while ((newline = this.buffer.indexOf('\n')) >= 0) {
        if (newline > MAX_FRAME) throw new Error('Frame too large');
        const line = this.buffer.slice(0, newline).trim();
        this.buffer = this.buffer.slice(newline + 1);
        if (line) this.receive(JSON.parse(line));
      }
      if (this.buffer.length > MAX_FRAME) throw new Error('Frame too large');
    } catch {
      this.fail(new BloomError('AGENT_PROTOCOL', 'The agent returned an invalid ACP stream.'));
      this.close();
    }
  }

  receive(message) {
    if (message?.jsonrpc !== '2.0') return;
    if (typeof message.method === 'string') {
      if (message.id == null) this.onNotification(message.method, message.params);
      else void this.respond(message);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    clearTimeout(pending.timer);
    if (message.error) {
      const code = typeof message.error.code === 'number' ? message.error.code : 'unknown';
      pending.reject(new BloomError('AGENT_REQUEST_REJECTED', 'The agent rejected ' + pending.method + ' (ACP ' + code + ').'));
    } else {
      pending.resolve(message.result);
    }
  }

  async respond({ id, method, params }) {
    let response;
    try {
      const result = await this.onRequest(method, params);
      response = result === undefined
        ? { id, error: { code: -32601, message: 'Client method unavailable' } }
        : { id, result };
    } catch {
      response = { id, error: { code: -32603, message: 'Client request could not be settled' } };
    }
    if (!this.failure) this.write(response);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.fail(disconnected());
    this.process.stdin.end();
    if (this.process.exitCode === null && this.process.signalCode === null) {
      this.process.kill('SIGTERM');
      const timer = setTimeout(() => this.process.kill('SIGKILL'), 1500);
      timer.unref();
      this.process.once('close', () => clearTimeout(timer));
    }
  }
}

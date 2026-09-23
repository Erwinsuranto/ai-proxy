import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import http from 'http';

const TEST_PORT = 3456;
const STARTUP_TIMEOUT = 15000;
let SERVER_URL = process.env.TEST_SERVER_URL || `http://localhost:${TEST_PORT}`;
let serverProcess: ChildProcess | null = null;

export function getBaseUrl(): string {
  return SERVER_URL;
}

/* Root of the ISOLATED state directory for this test run (see vitest.config.ts).
   Tests must resolve every persisted-state file (usage records, provider API
   keys, pricing, provider state, backups) through here so they operate on the
   same files the spawned server uses — never on live production data. */
export const TEST_CONFIG_DIR = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.resolve(__dirname, '..', 'config');

export function configFile(name: string): string {
  return path.join(TEST_CONFIG_DIR, name);
}

function waitForServer(url: string, timeoutMs = STARTUP_TIMEOUT): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      reject(new Error(`waitForServer timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    const check = () => {
      if (timedOut) return;
      const req = http.get(`${url}/health`, (res) => {
        res.resume();
        if (res.statusCode === 200) {
          clearTimeout(timer);
          resolve();
        } else if (Date.now() - start < timeoutMs) {
          setTimeout(check, 200);
        } else if (!timedOut) {
          clearTimeout(timer);
          reject(new Error(`waitForServer got status ${res.statusCode}`));
        }
      });
      req.on('error', () => {
        if (Date.now() - start < timeoutMs && !timedOut) {
          setTimeout(check, 200);
        } else if (!timedOut) {
          clearTimeout(timer);
          reject(new Error('waitForServer connection error'));
        }
      });
      req.setTimeout(2000, () => {
        req.destroy();
        if (Date.now() - start < timeoutMs && !timedOut) {
          setTimeout(check, 200);
        } else if (!timedOut) {
          clearTimeout(timer);
          reject(new Error('waitForServer request timeout'));
        }
      });
    };
    check();
  });
}

export async function startServer(envOverrides?: Record<string, string>): Promise<void> {
  if (process.env.TEST_SERVER_URL) return;

  const distPath = path.resolve(__dirname, '..', 'dist', 'server.js');
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    PORT: String(TEST_PORT),
    HOST: '127.0.0.1',
    LOG_LEVEL: 'silent',
    /* Clear API_KEY so the child does NOT inherit the real key from .env;
       dotenv won't override an existing (empty) value. Tests authenticate
       with `Bearer anything` and admin hooks become permissive. */
    API_KEY: envOverrides?.API_KEY ?? '',
    ...(envOverrides || {}),
  };
  if (!env.NVIDIA_API_KEY && !env.NVIDIA_API_KEYS) {
    env.NVIDIA_API_KEY = 'test-key';
  }

  const startMs = Date.now();
  const serverLog: string[] = [];

  serverProcess = spawn('node', [distPath], {
    cwd: path.resolve(__dirname, '..'),
    stdio: 'pipe',
    env,
  });

  serverProcess.stdout?.on('data', (d: Buffer) => { serverLog.push(d.toString()); });
  serverProcess.stderr?.on('data', (d: Buffer) => { serverLog.push(d.toString()); });

  serverProcess.on('exit', (code, signal) => {
    if (code !== null || signal !== 'SIGTERM') {
      console.error(`[TEST] Server exited code=${code} signal=${signal} after ${Date.now() - startMs}ms`);
      if (serverLog.length > 0) {
        console.error(`[TEST] Server logs:\n${serverLog.join('').slice(0, 1000)}`);
      }
    }
  });

  serverProcess.on('error', (err) => {
    console.error(`[TEST] Server error: ${err.message}`);
  });

  SERVER_URL = `http://127.0.0.1:${TEST_PORT}`;
  await waitForServer(SERVER_URL);
}

export async function stopServer(): Promise<void> {
  if (!serverProcess) return;
  const proc = serverProcess;
  serverProcess = null;

  return new Promise<void>((resolve) => {
    const killTimeout = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve();
    }, 3000);

    proc.on('exit', () => {
      clearTimeout(killTimeout);
      resolve();
    });

    proc.kill('SIGTERM');
  });
}

export function request(
  method: string,
  path: string,
  body?: any,
  timeoutMs = 15000,
): Promise<{ status: number; headers: http.IncomingHttpHeaders; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SERVER_URL);
    const headers: http.OutgoingHttpHeaders = {
      'Authorization': 'Bearer anything',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    const options: http.RequestOptions = {
      method,
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers,
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => { data += chunk.toString(); });
      res.on('end', () => {
        let parsed: any;
        const contentType = res.headers['content-type'] || '';
        if (contentType.includes('application/json')) {
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
        } else if (contentType.includes('text/event-stream')) {
          parsed = data;
        } else {
          try {
            parsed = JSON.parse(data);
          } catch {
            parsed = data;
          }
        }
        resolve({ status: res.statusCode || 0, headers: res.headers, data: parsed });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => {
      req.destroy();
      reject(new Error(`Request timeout after ${timeoutMs}ms: ${method} ${path}`));
    });
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

export function streamRequest(
  path: string,
  body: any,
): Promise<{ status: number; chunks: string[] }> {
  return new Promise((resolve, reject) => {
    const url = new URL(path, SERVER_URL);
    const options: http.RequestOptions = {
      method: 'POST',
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer anything',
      },
    };

    const req = http.request(options, (res) => {
      const chunks: string[] = [];
      res.on('data', (chunk: Buffer) => { chunks.push(chunk.toString()); });
      res.on('end', () => {
        resolve({ status: res.statusCode || 0, chunks });
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.setTimeout(10000, () => {
      req.destroy();
      reject(new Error('Stream request timeout'));
    });
    req.write(JSON.stringify(body));
    req.end();
  });
}

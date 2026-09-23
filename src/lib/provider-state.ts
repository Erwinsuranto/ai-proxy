import * as fs from 'fs';
import * as path from 'path';
import { DATA_DIR } from './data-dir';

const STATE_FILE = path.join(DATA_DIR, 'provider-state.json');

export function loadProviderState(): string[] {
  try {
    if (!fs.existsSync(STATE_FILE)) return [];
    const raw = fs.readFileSync(STATE_FILE, 'utf-8');
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && Array.isArray(parsed.disabledProviders)) return parsed.disabledProviders;
    return [];
  } catch {
    return [];
  }
}

export function saveProviderState(disabledIds: string[]): void {
  try {
    const dir = path.dirname(STATE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STATE_FILE, JSON.stringify({ disabledProviders: disabledIds }, null, 2), 'utf-8');
  } catch (err) {
    console.error('[ProviderState] Failed to save provider state:', err);
  }
}
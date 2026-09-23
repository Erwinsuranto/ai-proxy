import { MODEL_ALIASES } from '../config/model-aliases';

export function resolveModelAlias(model: string): string[] | null {
  return MODEL_ALIASES[model] ?? null;
}

export function isAlias(model: string): boolean {
  return model in MODEL_ALIASES;
}

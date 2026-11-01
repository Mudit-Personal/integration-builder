import { createHash } from 'node:crypto';
import type { Manifest } from './manifest.ts';

export const hashManifest = (m: Manifest) => createHash('sha256').update(JSON.stringify(m)).digest('hex').slice(0, 16);

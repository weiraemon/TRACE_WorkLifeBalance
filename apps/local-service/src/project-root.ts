import path from 'node:path';
import { fileURLToPath } from 'node:url';

// The portable service bundle keeps this module's directory depth.
export const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

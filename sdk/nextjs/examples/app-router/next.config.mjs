import path from 'node:path';
import { fileURLToPath } from 'node:url';
export default {
  experimental: { cpus: 2 },
  outputFileTracingRoot: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..'),
};

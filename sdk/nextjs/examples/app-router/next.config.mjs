import path from 'node:path';
import { fileURLToPath } from 'node:url';
const directory = path.dirname(fileURLToPath(import.meta.url));
export default {
  experimental: { cpus: 2 },
  outputFileTracingRoot: process.env.NELCOTA_NEXT_CHECKOUT === '1' ? path.resolve(directory, '../../../..') : directory,
};

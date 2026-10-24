export default {
  resolve: { alias: { 'server-only': new URL('./test/server-only.ts', import.meta.url).pathname } },
  test: { include: ['test/**/*.test.ts'], testTimeout: 10000, maxWorkers: 2 },
};

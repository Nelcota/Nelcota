// Tests run the SSR core from source, so the adapter and the test share one module
// graph (one Integration class) without a prior build of ../ssr.
const core = (path: string): string => new URL(`../ssr/src/${path}`, import.meta.url).pathname;
export default {
  resolve: {
    alias: [
      { find: 'server-only', replacement: new URL('./test/server-only.ts', import.meta.url).pathname },
      { find: /^@nelcota\/ssr\/postgres$/, replacement: core('postgres.ts') },
      { find: /^@nelcota\/ssr\/testing$/, replacement: core('memory-store.ts') },
      { find: /^@nelcota\/ssr\/browser$/, replacement: core('browser.ts') },
      { find: /^@nelcota\/ssr$/, replacement: core('index.ts') },
    ],
  },
  test: { include: ['test/**/*.test.ts'], testTimeout: 10000, maxWorkers: 2 },
};

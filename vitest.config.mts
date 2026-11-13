import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
const src = (p: string) => fileURLToPath(new URL(p, import.meta.url));
export default defineConfig({
  resolve: { alias: { '@': src('./src'), 'server-only': src('./tests/stubs/server-only.ts') } },
  test: {
    // db tests: `pnpm test:db` (TEST_DATABASE_URL); api tests: `pnpm test:api` (API_BASE). Plain `pnpm test` = unit only.
    include: ['tests/unit/**/*.test.ts', ...(process.env.TEST_DATABASE_URL ? ['tests/db/**/*.test.ts'] : []), ...(process.env.API_BASE ? ['tests/api/**/*.test.ts'] : []), ...(process.env.REAL_SUPABASE ? ['tests/real/**/*.test.ts'] : []), ...(process.env.CAPTCHA_FAIL ? ['tests/real-captcha-fail/**/*.test.ts'] : [])],
    testTimeout: 30000, hookTimeout: 60000,
  },
});

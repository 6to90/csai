/**
 * True only for builds made with CSAI_TEST_BUILD=1 (the test harness). The value is inlined at build time by next.config.ts, so a production build
 * cannot be switched into test behaviour by any runtime environment variable. Never build with this flag for real use.
 */
export const IS_TEST_BUILD = process.env.CSAI_TEST_BUILD === '1';

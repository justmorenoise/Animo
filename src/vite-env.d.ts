/// <reference types="vite/client" />

/**
 * The package version, replaced at build time by `define` in vite.config.ts.
 * Declared `undefined`-able because vitest uses its own config and never
 * substitutes it; `core/about.ts` is the only reader and handles that.
 */
declare const __APP_VERSION__: string | undefined;

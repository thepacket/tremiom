/** Full app version string, quantiom-style: <pkg>.<commitCount> (<shortSha>).
 *  The commit count is the auto-incrementing "most minor" segment — it bumps
 *  on every commit — and the short SHA pins the exact build. The three values
 *  are injected at build time by Vite's `define` (see vite.config.ts). */

declare const __APP_VERSION__: string;
declare const __GIT_COMMITS__: string;
declare const __GIT_SHA__: string;

export const APP_VERSION = `${__APP_VERSION__}.${__GIT_COMMITS__} (${__GIT_SHA__})`;

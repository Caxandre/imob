import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Absolute path to the backend package root (the directory containing this project's
 * `package.json`) — computed from this module's own file location, never from
 * `process.cwd()` (Prompt 039, section 62: a relative dev-only filesystem path from env config
 * must resolve deterministically regardless of the terminal's working directory when the
 * process was started). `src/config/project-root.ts` and its compiled `dist/config/
 * project-root.js` counterpart sit at the same depth under the package root (`tsconfig.build.json`
 * mirrors `src/` into `dist/` 1:1), so climbing two directories up from this file works
 * identically in `tsx` (dev) and the compiled build (prod).
 */
const BACKEND_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Resolves a developer-facing filesystem path against the backend root — an already-absolute
 * path is returned unchanged (section 61). */
export function resolveBackendPath(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(BACKEND_ROOT, inputPath);
}

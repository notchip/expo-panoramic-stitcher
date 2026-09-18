/**
 * Optional `expo-file-system` access for the sweep-manifest sidecar.
 *
 * `expo-file-system` is an optional peer: every Expo app has it (the `expo`
 * package depends on it), but the core stitcher must keep working — and the
 * consumer's bundle must keep building — when it is absent. The require is
 * therefore a LITERAL `require("expo-file-system")` inside `try/catch`,
 * exactly like `src/capture/optionalDeps.ts`: Metro's
 * `transformer.allowOptionalDependencies` (Expo's default metro config)
 * treats a require inside a try block as optional, so a missing package
 * neither fails the bundle nor throws at runtime. Do NOT convert this to a
 * static `import` and do not compute the module id.
 *
 * The load is lazy (first write, not module load) and memoized, so
 * consumers who never write a sidecar never touch the module.
 */

// `require` exists at runtime under Metro/jest; our tsconfig restricts
// ambient @types (types: ["jest"]) so declare the minimal shape here.
declare const require: (moduleId: string) => unknown;

/** The slice of `expo-file-system`'s `File` class we use (SDK 56+). */
type FileCtor = new (uri: string) => { write: (content: string) => void };

let cached: { File: FileCtor } | null | undefined;

function loadFileSystem(): { File: FileCtor } | null {
  if (cached !== undefined) return cached;
  try {
    const mod = require("expo-file-system") as { File?: unknown } | null;
    const File = mod && typeof mod === "object" ? mod.File : undefined;
    cached = typeof File === "function" ? { File: File as FileCtor } : null;
  } catch {
    cached = null;
  }
  return cached;
}

/**
 * A `file://` URI for a bare filesystem path; anything that already has a
 * URL scheme is returned untouched. `expo-file-system`'s `File` rejects
 * scheme-less paths on iOS, so every path goes through this.
 */
export function toFileUri(path: string): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(path)) return path;
  // encodeURI keeps "/" but also keeps "#" and "?", which would truncate a
  // path when parsed as a URL — encode those two explicitly.
  return "file://" + encodeURI(path).replace(/[#?]/g, encodeURIComponent);
}

/**
 * Write `text` to `path` (bare path or `file://` URI) with
 * `expo-file-system`'s synchronous `File.write` (SDK 56+). Creates the file,
 * not its parent directories. Throws when `expo-file-system` is not
 * installed or the write fails — callers treat it as best-effort.
 */
export function writeTextFile(path: string, text: string): void {
  const fs = loadFileSystem();
  if (!fs) {
    throw new Error(
      "expo-file-system is not installed (it ships with every Expo app; " +
        "run `npx expo install expo-file-system`)",
    );
  }
  new fs.File(toFileUri(path)).write(text);
}

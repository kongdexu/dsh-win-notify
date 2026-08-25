/**
 * dsh-win-notify public types.
 *
 * The plugin is a host-side Cordis bundle: it exports the standard
 * `{ name, inject, apply }` contract, plus `HELPER_DIR` for tooling. The
 * context it consumes is structural (`NotifyContext`) — the real DSH host
 * `Context` satisfies it, and no cordis types are required at runtime.
 */

/** Minimal host-context surface this plugin consumes (structural). */
export interface NotifyContext {
  get<T = unknown>(name: string): T
  on(event: string, listener: (...args: any[]) => unknown): unknown
  subprocess: {
    spawn(opts: { argv: string[]; cwd?: string; stdio?: unknown; graceMs?: number }): {
      done?: Promise<unknown>
    }
  }
}

/** Cordis plugin name used by loader diagnostics. */
export declare const name: 'dsh-win-notify'

/** The subprocess service must exist before this plugin can spawn helpers. */
export declare const inject: readonly ['subprocess']

/** Absolute path of the shipped helper directory (next to the built entry). */
export declare const HELPER_DIR: string

/**
 * Windows-only system-notification plugin. On non-Windows hosts `apply()`
 * writes a warning and registers nothing.
 */
export declare function apply(ctx: NotifyContext): void
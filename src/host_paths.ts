import path from 'node:path'

interface HostApp {
  makePath(...segments: string[]): string
}

/** The AdonisJS app service, or `null` outside an AdonisJS process. The only place `src/` asks the framework for paths. */
async function loadHostApp(): Promise<HostApp | null> {
  try {
    const { default: app } = await import('@adonisjs/core/services/app')
    return (app as HostApp | undefined) ?? null
  } catch {
    return null
  }
}

/**
 * A path under the application root: `app.makePath(...segments)` inside an AdonisJS process, otherwise (no AdonisJS,
 * or an app that is not booted yet) the same segments under the working directory.
 */
export async function hostPath(...segments: string[]): Promise<string> {
  const app = await loadHostApp()
  try {
    if (app) return app.makePath(...segments)
  } catch {
    // The app service exists but the app is not booted: use the working directory instead.
  }
  return path.resolve(process.cwd(), ...segments)
}

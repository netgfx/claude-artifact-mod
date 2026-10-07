/** One produced file: only its local path and when it was first seen. */
export type Artifact = { path: string; addedAt: number }

declare module 'claude-code' {
  interface PluginState {
    'artifact-mod': {
      artifacts: Artifact[]
      page: number
      selected: string
    }
  }
}

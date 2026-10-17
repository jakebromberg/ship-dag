/** One point of interest on the bar's time axis. */
export type EtaMarker = { id: string; glyph: string; label: string; at: number }

/** The bar's model (`barModel` in lib/bar.mjs): the axis, the merged count, the binding marker and every marker. */
export type EtaBar = {
  runId: string
  now: number
  start: number
  end: number
  merged: number
  total: number
  binding: string | null
  markers: EtaMarker[]
}

declare module 'claude-code' {
  interface PluginState {
    'ship-dag-eta': { bar: EtaBar | null }
  }
}

import { MODES, type TutorMode } from "./types"

export interface ModeSwitchResult {
  mode: TutorMode
  changed: boolean
  notice?: string
}

export function switchMode(
  current: TutorMode,
  direction: 1 | -1,
  isGenerating: boolean,
): ModeSwitchResult {
  if (isGenerating) {
    return { mode: current, changed: false, notice: "先按 Ctrl+C 取消当前回答" }
  }

  const index = MODES.indexOf(current)
  const next = MODES[(index + direction + MODES.length) % MODES.length]
  return { mode: next, changed: true }
}

export function modeLabel(mode: TutorMode): string {
  return mode[0].toUpperCase() + mode.slice(1)
}

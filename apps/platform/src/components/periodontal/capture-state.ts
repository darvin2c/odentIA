/**
 * Lógica de la captura en secuencia (lienzo, tablero 3), sin pantalla: una
 * pieza y una cara a la vez, las tres profundidades y luego las tres
 * recesiones, y pasa sola a la siguiente. El orden de las piezas es el de
 * `probingSequence`; dentro de cada cara se escribe en el sentido en que
 * avanza la sonda (arriba por fuera y abajo por dentro, de izquierda a derecha
 * en pantalla; las otras dos, de derecha a izquierda).
 */
import {
  emptyPeriodontalTooth,
  PERIODONTAL_SITE_WORDS,
  type PeriodontalProbingStep,
  type PeriodontalToothRecord,
  PROBING_DEPTH_MAX_MM,
  probingPassWords,
  RECESSION_MAX_MM,
  RECESSION_MIN_MM,
} from "@odentia/clinical"
import { isUpper } from "./anatomy"
import { type ChartFace, displaySites } from "./periodontal-chart"

export type CaptureTeeth = Record<number, PeriodontalToothRecord>

export interface CaptureState {
  teeth: CaptureTeeth
  steps: PeriodontalProbingStep[]
  /** Paso (pieza y cara) y campo: 0 a 2 las profundidades y 3 a 5 las recesiones, en el orden en que se escriben. */
  cursor: { step: number; field: number }
  /** Se pulsó «−»: la próxima recesión va en negativo. */
  minus: boolean
  /** Lo último que se escribió, para el sangrado y para escribir 10 a 15 con dos dígitos seguidos. */
  last: { step: number; field: number; at: number } | null
  /** Ya se escribió la última recesión de la última cara. */
  done: boolean
}

export type CaptureKey =
  | { kind: "digit"; value: number }
  | { kind: "minus" }
  | { kind: "back" }
  | { kind: "move"; direction: "left" | "right" | "up" | "down" }
  | { kind: "bleeding" }
  | { kind: "suppuration" }
  | { kind: "skip" }

export interface CaptureResult {
  state: CaptureState
  /** Piezas que cambiaron y hay que guardar. */
  changed: number[]
  /** Lo que dice el lector de pantalla. */
  say: string
}

/** Dos dígitos seguidos dentro de este plazo escriben 10 a 15 en el mismo sitio. */
export const TWO_DIGIT_MS = 800

export const chartFace = (step: PeriodontalProbingStep): ChartFace => (step.face === "buccal" ? "out" : "in")

/** De izquierda a derecha en pantalla: arriba por fuera y abajo por dentro. */
export function leftToRight(step: PeriodontalProbingStep): boolean {
  return isUpper(step.toothNumber) === (step.face === "buccal")
}

/** Posiciones en pantalla (0 a 2, de izquierda a derecha) en el orden en que se escriben. */
export function typingPositions(step: PeriodontalProbingStep): [number, number, number] {
  return leftToRight(step) ? [0, 1, 2] : [2, 1, 0]
}

/** El sitio (orden guardado) de un campo del paso. */
export function fieldSite(step: PeriodontalProbingStep, field: number): number {
  return displaySites(step.toothNumber, chartFace(step))[typingPositions(step)[field % 3]!]!
}

export const fieldKind = (field: number): "pd" | "rec" => (field < 3 ? "pd" : "rec")

/** El campo que ocupa una posición de pantalla en una fila. */
export function fieldAt(step: PeriodontalProbingStep, row: "pd" | "rec", position: number): number {
  const index = typingPositions(step).indexOf(position)
  return (row === "pd" ? 0 : 3) + index
}

/** «Pieza 26, por fuera, mesial, profundidad»: el nombre completo de un campo. */
export function fieldLabel(step: PeriodontalProbingStep, field: number): string {
  const site = fieldSite(step, field)
  const where = PERIODONTAL_SITE_WORDS[site]!.split(" ")[0]!
  return `Pieza ${step.toothNumber}, ${step.face === "buccal" ? "por fuera" : "por dentro"}, ${where}, ${fieldKind(field) === "pd" ? "profundidad" : "recesión"}`
}

/** «de mesial a distal →»: en qué sentido se escribe la cara. */
export function directionWords(step: PeriodontalProbingStep): string {
  const first = PERIODONTAL_SITE_WORDS[fieldSite(step, 0)]!.split(" ")[0]
  const last = PERIODONTAL_SITE_WORDS[fieldSite(step, 2)]!.split(" ")[0]
  return leftToRight(step) ? `de ${first} a ${last} →` : `← de ${first} a ${last}`
}

export function cellValue(teeth: CaptureTeeth, step: PeriodontalProbingStep, field: number): number | null {
  const tooth = teeth[step.toothNumber]
  if (!tooth) return null
  const site = fieldSite(step, field)
  return (fieldKind(field) === "pd" ? tooth.probingDepth[site] : tooth.recession[site]) ?? null
}

function withTooth(teeth: CaptureTeeth, toothNumber: number, change: (tooth: PeriodontalToothRecord) => PeriodontalToothRecord): CaptureTeeth {
  const tooth = teeth[toothNumber] ?? emptyPeriodontalTooth(toothNumber)
  return { ...teeth, [toothNumber]: change(tooth) }
}

function setField(teeth: CaptureTeeth, step: PeriodontalProbingStep, field: number, value: number | null): CaptureTeeth {
  const site = fieldSite(step, field)
  return withTooth(teeth, step.toothNumber, (tooth) => {
    const probingDepth = [...tooth.probingDepth]
    const recession = [...tooth.recession]
    if (fieldKind(field) === "pd") probingDepth[site] = value
    else recession[site] = value
    // Escribir en una pieza saltada la vuelve a medir.
    return { ...tooth, skipped: false, probingDepth, recession }
  })
}

/** El primer campo sin escribir de la secuencia, para empezar o seguir donde quedó. */
export function firstOpenCursor(teeth: CaptureTeeth, steps: PeriodontalProbingStep[]): { step: number; field: number } | null {
  for (let step = 0; step < steps.length; step++) {
    const s = steps[step]!
    if (teeth[s.toothNumber]?.skipped) continue
    for (let field = 0; field < 6; field++) if (cellValue(teeth, s, field) === null) return { step, field }
  }
  return null
}

export function initialCaptureState(teeth: CaptureTeeth, steps: PeriodontalProbingStep[]): CaptureState {
  const open = firstOpenCursor(teeth, steps)
  return { teeth, steps, cursor: open ?? { step: Math.max(0, steps.length - 1), field: 5 }, minus: false, last: null, done: open === null }
}

/** Lleva el cursor a una pieza: a su cara del mismo lado si existe, si no a su primer paso. */
export function jumpToTooth(state: CaptureState, toothNumber: number): CaptureState {
  const current = state.steps[state.cursor.step]
  const same = state.steps.findIndex((s) => s.toothNumber === toothNumber && s.face === current?.face)
  const any = state.steps.findIndex((s) => s.toothNumber === toothNumber)
  const step = same >= 0 ? same : any
  if (step < 0) return state
  const s = state.steps[step]!
  let field = 0
  while (field < 5 && cellValue(state.teeth, s, field) !== null) field++
  return { ...state, cursor: { step, field }, minus: false, last: null, done: false }
}

function stepWords(step: PeriodontalProbingStep): string {
  return `la ${step.toothNumber} ${step.face === "buccal" ? "por fuera" : "por dentro"}`
}

function advance(state: CaptureState): { cursor: CaptureState["cursor"]; done: boolean } {
  const { step, field } = state.cursor
  if (field < 5) return { cursor: { step, field: field + 1 }, done: false }
  for (let next = step + 1; next < state.steps.length; next++) {
    if (!state.teeth[state.steps[next]!.toothNumber]?.skipped) return { cursor: { step: next, field: 0 }, done: false }
  }
  return { cursor: { step, field }, done: true }
}

/** Aplica una tecla de la captura. Solo cambia lo que dice el lienzo; lo demás no hace nada. */
export function applyCaptureKey(state: CaptureState, key: CaptureKey, now: number): CaptureResult {
  const step = state.steps[state.cursor.step]
  if (!step) return { state, changed: [], say: "" }
  const { field } = state.cursor
  switch (key.kind) {
    case "digit": {
      const last = state.last
      // «1» y enseguida otro dígito: 10 a 15 en el sitio que acaba de escribirse.
      if (last && now - last.at <= TWO_DIGIT_MS && !state.minus) {
        const lastStep = state.steps[last.step]!
        const previous = cellValue(state.teeth, lastStep, last.field)
        const max = fieldKind(last.field) === "pd" ? PROBING_DEPTH_MAX_MM : RECESSION_MAX_MM
        if (previous === 1 && 10 + key.value <= max) {
          const teeth = setField(state.teeth, lastStep, last.field, 10 + key.value)
          return {
            state: { ...state, teeth, last: null },
            changed: [lastStep.toothNumber],
            say: `${fieldLabel(lastStep, last.field)}: ${10 + key.value} mm`,
          }
        }
      }
      const kind = fieldKind(field)
      const value = kind === "rec" && state.minus ? -key.value : key.value
      if (kind === "rec" && value < RECESSION_MIN_MM) return { state: { ...state, minus: false }, changed: [], say: `La recesión va de ${RECESSION_MIN_MM} a ${RECESSION_MAX_MM} mm` }
      const teeth = setField(state.teeth, step, field, value)
      const moved = advance({ ...state, teeth })
      const next = { ...state, teeth, cursor: moved.cursor, done: moved.done, minus: false, last: { step: state.cursor.step, field, at: now } }
      let say = `${fieldLabel(step, field)}: ${value} mm`
      if (moved.done) say += ". Sondaje completo"
      else if (moved.cursor.step !== state.cursor.step) say += `. Lista ${stepWords(step)}; sigue ${stepWords(state.steps[moved.cursor.step]!)}`
      else if (field === 2) say += `. Faltan las recesiones de la ${step.toothNumber}`
      return { state: next, changed: [step.toothNumber], say }
    }
    case "minus":
      if (fieldKind(field) !== "rec") return { state, changed: [], say: "El signo menos va solo en la recesión" }
      return { state: { ...state, minus: !state.minus }, changed: [], say: state.minus ? "Recesión positiva" : "Recesión negativa: escribe el número" }
    case "back": {
      if (state.minus) return { state: { ...state, minus: false }, changed: [], say: "Recesión positiva" }
      // Borra el sitio actual si tiene valor; si no, vuelve uno y lo borra.
      let target = state.cursor
      if (cellValue(state.teeth, step, field) === null && !state.done) {
        target = field > 0 ? { step: state.cursor.step, field: field - 1 } : state.cursor.step > 0 ? { step: state.cursor.step - 1, field: 5 } : state.cursor
      }
      const targetStep = state.steps[target.step]!
      const teeth = setField(state.teeth, targetStep, target.field, null)
      return {
        state: { ...state, teeth, cursor: target, done: false, last: null },
        changed: [targetStep.toothNumber],
        say: `${fieldLabel(targetStep, target.field)}: borrado`,
      }
    }
    case "move": {
      const row = fieldKind(field)
      const position = typingPositions(step)[field % 3]!
      if (key.direction === "up" || key.direction === "down") {
        const target = fieldAt(step, key.direction === "up" ? "pd" : "rec", position)
        return { state: { ...state, cursor: { step: state.cursor.step, field: target }, minus: false, last: null, done: false }, changed: [], say: fieldLabel(step, target) }
      }
      const nextPosition = position + (key.direction === "right" ? 1 : -1)
      if (nextPosition < 0 || nextPosition > 2) return { state, changed: [], say: "" }
      const target = fieldAt(step, row, nextPosition)
      return { state: { ...state, cursor: { step: state.cursor.step, field: target }, minus: false, last: null, done: false }, changed: [], say: fieldLabel(step, target) }
    }
    case "bleeding":
    case "suppuration": {
      // El sitio que se acaba de escribir; si no, el del cursor.
      const at = state.last ?? { ...state.cursor }
      const atStep = state.steps[at.step]!
      const site = fieldSite(atStep, at.field)
      const teeth = withTooth(state.teeth, atStep.toothNumber, (tooth) => {
        const list = [...(key.kind === "bleeding" ? tooth.bleeding : tooth.suppuration)]
        list[site] = !list[site]
        return key.kind === "bleeding" ? { ...tooth, bleeding: list } : { ...tooth, suppuration: list }
      })
      const on = (key.kind === "bleeding" ? teeth[atStep.toothNumber]!.bleeding : teeth[atStep.toothNumber]!.suppuration)[site]
      const where = `${atStep.toothNumber}, ${PERIODONTAL_SITE_WORDS[site]}`
      return {
        state: { ...state, teeth },
        changed: [atStep.toothNumber],
        say: `${where}: ${key.kind === "bleeding" ? (on ? "sangra" : "no sangra") : on ? "supura" : "no supura"}`,
      }
    }
    case "skip": {
      const teeth = withTooth(state.teeth, step.toothNumber, (tooth) => ({
        ...emptyPeriodontalTooth(step.toothNumber),
        mobility: tooth.mobility,
        plaque: tooth.plaque,
        periImplant: tooth.periImplant,
        skipped: true,
      }))
      let next = -1
      for (let i = state.cursor.step + 1; i < state.steps.length; i++) {
        if (state.steps[i]!.toothNumber !== step.toothNumber && !teeth[state.steps[i]!.toothNumber]?.skipped) {
          next = i
          break
        }
      }
      const done = next < 0
      return {
        state: { ...state, teeth, cursor: done ? state.cursor : { step: next, field: 0 }, done, minus: false, last: null },
        changed: [step.toothNumber],
        say: `Pieza ${step.toothNumber} saltada${done ? ". Sondaje completo" : `; sigue ${stepWords(state.steps[next]!)}`}`,
      }
    }
  }
}

/** «Arriba por fuera · pieza 13 de 14»: dónde va el sondaje. */
export function progressWords(state: CaptureState): string {
  const step = state.steps[state.cursor.step]
  if (!step) return ""
  const pass = probingPassWords(step)
  const sameRun = state.steps.filter((s) => probingPassWords(s) === pass)
  const index = sameRun.indexOf(step) + 1
  return `${pass.charAt(0).toUpperCase()}${pass.slice(1)} · pieza ${index} de ${sameRun.length}`
}

/** La tecla de la captura que corresponde a una tecla del teclado; null si no es suya. */
export function keyFromEvent(event: { key: string; ctrlKey?: boolean; metaKey?: boolean; altKey?: boolean }): CaptureKey | null {
  if (event.ctrlKey || event.metaKey || event.altKey) return null
  if (/^[0-9]$/.test(event.key)) return { kind: "digit", value: Number(event.key) }
  switch (event.key) {
    case "-":
    case "−":
      return { kind: "minus" }
    case "Backspace":
    case "Delete":
      return { kind: "back" }
    case "ArrowLeft":
      return { kind: "move", direction: "left" }
    case "ArrowRight":
      return { kind: "move", direction: "right" }
    case "ArrowUp":
      return { kind: "move", direction: "up" }
    case "ArrowDown":
      return { kind: "move", direction: "down" }
    case "s":
    case "S":
      return { kind: "bleeding" }
    case "p":
    case "P":
      return { kind: "suppuration" }
    case "x":
    case "X":
      return { kind: "skip" }
    default:
      return null
  }
}

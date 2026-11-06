import { emptyPeriodontalTooth, probingSequence } from "@odentia/dental"
import { describe, expect, it } from "vitest"
import {
  applyCaptureKey,
  type CaptureKey,
  type CaptureState,
  directionWords,
  fieldLabel,
  initialCaptureState,
  jumpToTooth,
  keyFromEvent,
  progressWords,
} from "./capture-state"

const TEETH = [17, 16, 26, 27, 47, 46, 36, 37]

function start(): CaptureState {
  const teeth = Object.fromEntries(TEETH.map((tooth) => [tooth, emptyPeriodontalTooth(tooth)]))
  return initialCaptureState(teeth, probingSequence(TEETH))
}

function press(state: CaptureState, keys: Array<CaptureKey | string>): CaptureState {
  for (const key of keys) {
    const parsed = typeof key === "string" ? keyFromEvent({ key }) : key
    if (!parsed) throw new Error(`tecla sin uso: ${String(key)}`)
    // Sin reloj: da igual el ritmo con que se teclea (ADR 0142).
    state = applyCaptureKey(state, parsed).state
  }
  return state
}

describe("captura en secuencia del periodontograma", () => {
  it("sigue la sonda: arriba por fuera de izquierda a derecha, con sus campos nombrados", () => {
    const state = start()
    const first = state.steps[state.cursor.step]!
    expect(first).toEqual({ toothNumber: 17, face: "buccal" })
    // La 17 está a la izquierda de la pantalla: su distal queda a la izquierda.
    expect(directionWords(first)).toBe("de distal a mesial →")
    expect(fieldLabel(first, 0)).toBe("Pieza 17, por fuera, distal, profundidad")
    expect(progressWords(state)).toBe("Arriba por fuera · pieza 1 de 4")
    // Arriba por dentro la sonda vuelve de la 27 a la 17: de derecha a izquierda.
    expect(directionWords({ toothNumber: 27, face: "lingual" })).toBe("← de distal a mesial")
  })

  it("tres profundidades, tres recesiones y pasa sola a la siguiente pieza", () => {
    const state = press(start(), ["5", "3", "6", "0", "-", "1", "2"])
    const tooth = state.teeth[17]!
    // Distal, centro y mesial por fuera de la 17 (sitios 2, 1 y 0).
    expect(tooth.probingDepth.slice(0, 3)).toEqual([6, 3, 5])
    expect(tooth.recession.slice(0, 3)).toEqual([2, -1, 0])
    expect(state.steps[state.cursor.step]).toEqual({ toothNumber: 16, face: "buccal" })
    expect(state.cursor.field).toBe(0)
  })

  it("cada cifra va a su sitio al pulsarla, y 10 a 15 se escriben con «+» y la segunda cifra (ADR 0142)", () => {
    // «2 1 2» seguido son tres sitios, al ritmo que sea: el «1» nunca se une con la siguiente.
    let state = press(start(), ["2", "1", "2"])
    expect(state.teeth[17]!.probingDepth.slice(0, 3)).toEqual([2, 1, 2])
    // «+» y «2» es 12, en un solo sitio; el cursor pasa al siguiente.
    state = press(start(), ["+", "2", "3"])
    expect(state.teeth[17]!.probingDepth.slice(0, 3)).toEqual([null, 3, 12])
    expect(state.cursor.field).toBe(2)
    // Más de 15 no existe: lo dice y no escribe nada.
    const over = applyCaptureKey(press(start(), ["+"]), { kind: "digit", value: 6 })
    expect(over.say).toBe("La profundidad va de 0 a 15 mm")
    expect(over.state.teeth[17]!.probingDepth[2]).toBeNull()
    expect(over.state.tens).toBe(false)
    // «+» otra vez, o ⌫, lo deshace sin borrar nada.
    expect(press(start(), ["+", "+"]).tens).toBe(false)
    expect(press(start(), ["+", "Backspace"]).tens).toBe(false)
  })

  it("la recesión de −10 se escribe con «−», «+» y 0", () => {
    const state = press(start(), ["1", "1", "1", "-", "+", "0"])
    expect(state.teeth[17]!.recession[2]).toBe(-10)
    // −11 no existe.
    expect(applyCaptureKey(press(start(), ["1", "1", "1", "-", "+"]), { kind: "digit", value: 1 }).say).toBe("La recesión va de -10 a 15 mm")
  })

  it("S y P marcan el sitio que se acaba de escribir", () => {
    const state = press(start(), ["4", "s", "p", "p"])
    expect(state.teeth[17]!.bleeding[2]).toBe(true)
    expect(state.teeth[17]!.suppuration[2]).toBe(false)
  })

  it("borrar vuelve un sitio; las flechas se mueven sin borrar", () => {
    let state = press(start(), ["4", "3"])
    state = press(state, ["Backspace"])
    expect(state.teeth[17]!.probingDepth.slice(0, 3)).toEqual([null, null, 4])
    expect(state.cursor.field).toBe(1)
    state = press(state, ["ArrowLeft"])
    // A la izquierda en pantalla está el distal, que se escribió primero.
    expect(state.cursor.field).toBe(0)
    state = press(state, ["ArrowDown"])
    expect(state.cursor.field).toBe(3)
  })

  it("saltar pieza la deja sin medir, marcada, y sigue con la siguiente", () => {
    const state = press(start(), ["4", "x"])
    expect(state.teeth[17]).toMatchObject({ skipped: true, probingDepth: [null, null, null, null, null, null] })
    expect(state.steps[state.cursor.step]).toEqual({ toothNumber: 16, face: "buccal" })
    // Arriba por dentro, la 17 también se salta sola.
    const back = jumpToTooth(state, 17)
    expect(back.steps[back.cursor.step]!.toothNumber).toBe(17)
  })

  it("solo atiende sus teclas", () => {
    expect(keyFromEvent({ key: "a" })).toBeNull()
    expect(keyFromEvent({ key: "5", ctrlKey: true })).toBeNull()
    expect(keyFromEvent({ key: "−" })).toEqual({ kind: "minus" })
    expect(keyFromEvent({ key: "+" })).toEqual({ kind: "plus" })
  })
})

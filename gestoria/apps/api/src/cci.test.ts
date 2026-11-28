/**
 * Los dígitos de control del CCI, con casos reales publicados por quienes los usan para recibir
 * dinero (noviembre de 2026):
 *
 * - Cámara de Comercio de Lima, cuenta de ahorros en soles del BCP, CCI 002 193 103054216066 14
 *   («Seamos solidarios…», lacamara.pe).
 * - Asociación de las Bienaventuranzas (campaña con Cáritas Lurín), BCP, CCI
 *   002-194-008283576082-96 (aciprensa.com, campaña de Navidad 2021).
 *
 * Y lo que debe rechazar: un número cambiado, dos vecinos cambiados de lugar y el largo.
 */
import { describe, expect, it } from "vitest"
import { cciBank, cciProblem, cciText } from "./cci.js"

describe("el CCI y sus dígitos de control", () => {
  it("acepta los CCI publicados, con o sin separadores", () => {
    expect(cciProblem("00219310305421606614")).toBeNull()
    expect(cciProblem("002-194-008283576082-96")).toBeNull()
    expect(cciProblem("002 193 103054216066 14")).toBeNull()
  })

  it("rechaza un número equivocado, en la oficina o en la cuenta", () => {
    expect(cciProblem("00219410305421606614")).toBe("control")
    expect(cciProblem("00219310305421606714")).toBe("control")
  })

  it("rechaza dos números vecinos cambiados de lugar", () => {
    expect(cciProblem("00219301305421606614")).toBe("control")
  })

  it("dice cuando no son 20 números", () => {
    expect(cciProblem("0021931030542160661")).toBe("largo")
    expect(cciProblem("002193103054216066145")).toBe("largo")
    expect(cciProblem("0021931030542160661A")).toBe("numeros")
  })

  it("el ejemplo del lienzo (…012 55) no pasa; con sus dígitos de control, sí", () => {
    expect(cciProblem("00219100234567801255")).toBe("control")
    expect(cciProblem("00219100234567801253")).toBeNull()
  })

  it("lee el banco y escribe el CCI como lo muestran los bancos", () => {
    expect(cciBank("002-194-008283576082-96")).toBe("002")
    expect(cciText("00219310305421606614")).toBe("002 193 103054216066 14")
  })
})

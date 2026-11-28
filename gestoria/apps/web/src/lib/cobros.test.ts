import { describe, expect, it } from "vitest"
import { cciCheck, cciIssue, cciReady, netOf, walletPreview, whoConfirms } from "./cobros"

/**
 * Lo que la pantalla dice mientras se escribe: los mismos casos del servidor (`apps/api/src/
 * cci.test.ts`), CCI publicados por quienes los usan para recibir dinero.
 */
describe("el CCI mientras se escribe", () => {
  it("acepta los CCI publicados y dice lo que falta o no coincide", () => {
    expect(cciCheck("00219310305421606614")).toBe("ok")
    expect(cciCheck("002-194-008283576082-96")).toBe("ok")
    expect(cciCheck("002 191 002345678012 55")).toBe("control")
    expect(cciCheck("0021931030")).toBe("incompleto")
    expect(cciCheck("")).toBe("vacio")
    expect(cciCheck("00219A")).toBe("numeros")
  })

  it("dice como error un CCI de otro banco que el elegido, aunque sus dígitos cuadren", () => {
    const banks = [
      { code: "002", short: "BCP", name: "Banco de Crédito del Perú (BCP)" },
      { code: "003", short: "Interbank", name: "Interbank" },
    ]
    expect(cciIssue("002 191 002345678012 53", "002", banks)).toBeNull()
    expect(cciIssue("003 200 003012345678 39", "002", banks)).toBe(
      "Ese CCI es de Interbank, no de BCP: revisa el banco o el CCI.",
    )
    expect(cciIssue("003 200 003012345678 39", "", banks)).toBeNull()
    expect(cciIssue("002 191 002345678012 55", "002", banks)).toMatch(/dígitos de control/)
    expect(cciIssue("0021931030", "002", banks)).toBe("El CCI tiene 20 números: llevas 10.")
    expect(cciIssue("", "002", banks)).toBeNull()
    expect(cciReady("0021931030")).toBe(false)
    expect(cciReady("002 191 002345678012 55")).toBe(true)
    expect(cciReady("00219A")).toBe(true)
  })
})

describe("Cobros en palabras", () => {
  it("por S/ 100 recibe S/ 94,70 con la comisión publicada", () => {
    expect(netOf(10000)).toBe(9470)
  })

  it("quién confirma cada forma", () => {
    expect(whoConfirms({ kind: "yape", collection: "comprobante" })).toBe(
      "Tú o Ventas, con la captura",
    )
    expect(whoConfirms({ kind: "pos", collection: "al_recibir" })).toBe(
      "El repartidor, con la foto del voucher",
    )
  })

  it("así le llega a la clienta el dato de Yape", () => {
    // Sin «escanear este QR»: hoy ningún canal manda la imagen.
    expect(walletPreview("yape", "+51987654321", "Rosa Quispe M.", "S/ 141")).toBe(
      "Puedes yapear S/ 141 al 987 654 321 (Rosa Quispe M.). Mándame la captura y te confirmo.",
    )
  })
})

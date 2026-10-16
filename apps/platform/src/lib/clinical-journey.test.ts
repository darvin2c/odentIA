import { afterEach, describe, expect, it } from "vitest"
import { clinicDateTimeValue, formatDate, instantFromClinicValue } from "./clinical-journey"
import { setOrgLocale } from "./locale"

afterEach(() => {
  setOrgLocale(undefined, undefined)
})

describe("fechas clínicas en la zona de la clínica, no en la del navegador", () => {
  it("un campo de fecha y hora se lee y se escribe con el reloj de la clínica", () => {
    // Una clínica en Tokio (UTC+9): sea cual sea la zona de quien corre la prueba.
    setOrgLocale("es-PE", "Asia/Tokyo")
    expect(clinicDateTimeValue("2026-10-22T01:30:00.000Z")).toBe("2026-10-22T10:30")
    expect(instantFromClinicValue("2026-10-22T10:30")).toBe("2026-10-22T01:30:00.000Z")
    // Pasada la medianoche de la clínica es otro día, aunque en UTC aún no lo sea.
    expect(clinicDateTimeValue("2026-10-22T16:00:00.000Z")).toBe("2026-10-23T01:00")
    expect(instantFromClinicValue("2026-10-22T25:00")).toBeNull()
    expect(instantFromClinicValue("")).toBeNull()
  })

  it("una fecha sin hora no se mueve de día", () => {
    setOrgLocale("es-PE", "America/Lima")
    expect(formatDate("2026-10-22")).toBe("22/10/2026")
    // Un instante se dice en el día de la clínica: las 02:00 UTC aún son el día anterior en Lima.
    expect(formatDate("2026-10-22T02:00:00.000Z")).toBe("21/10/2026")
  })
})

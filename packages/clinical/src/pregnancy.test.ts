import { describe, expect, it } from "vitest"
import {
  checkInterviewPregnancy,
  declaredPregnancy,
  legacyPregnancySaidOn,
  pregnancyRecordOf,
  pregnancyToday,
} from "./pregnancy.js"

describe("el embarazo declarado, con la semana de hoy y su caducidad", () => {
  const said = { embarazoLactancia: { embarazo: { estado: "si", fecha: "2026-11-13", semanas: 30 } } }

  it("dice la semana de hoy: 30 el 13 nov son 32 dos semanas después y 34 al mes", () => {
    expect(pregnancyToday(said, "2026-11-13")).toEqual({ state: "vigente", saidOn: "2026-11-13", weeksSaid: 30, weeksToday: 30 })
    expect(pregnancyToday(said, "2026-11-27")?.weeksToday).toBe(32)
    expect(pregnancyToday(said, "2026-12-11")?.weeksToday).toBe(34)
  })

  it("pasada la semana 42 deja de ser alerta y pide confirmar", () => {
    // Semana 42 todavía en pie; un día después de terminarla, ya no.
    expect(pregnancyToday(said, "2027-02-05")).toMatchObject({ state: "vigente", weeksToday: 42 })
    expect(pregnancyToday(said, "2027-02-12")).toEqual({
      state: "por_confirmar",
      saidOn: "2026-11-13",
      weeksSaid: 30,
      weeksToday: null,
    })
  })

  it("sin las semanas no las inventa, y caduca a las 42 semanas de haberlo dicho", () => {
    const noWeeks = { embarazoLactancia: { embarazo: { estado: "si", fecha: "2026-11-13" } } }
    expect(pregnancyToday(noWeeks, "2026-12-13")).toEqual({ state: "vigente", saidOn: "2026-11-13", weeksSaid: null, weeksToday: null })
    expect(pregnancyToday(noWeeks, "2027-09-10")?.state).toBe("por_confirmar")
  })

  it("lo guardado antes, si de verdad no tiene fecha, se lee y pide confirmar: no hay semana de hoy que decir", () => {
    const before = { antecedentesPersonales: { embarazo: true, semanasEmbarazo: 20 } }
    expect(pregnancyRecordOf(before)).toEqual({ estado: "si", fecha: null, semanas: 20 })
    expect(pregnancyToday(before, "2026-11-13")).toEqual({ state: "por_confirmar", saidOn: null, weeksSaid: 20, weeksToday: null })
  })

  it("sin las semanas dichas, las cuenta desde la última regla si está anotada", () => {
    const byFur = {
      embarazoLactancia: { embarazo: { estado: "si", fecha: "2026-10-24" } },
      ginecoObstetricos: { fur: "2026-08-01" },
    }
    expect(pregnancyToday(byFur, "2026-10-24")).toEqual({ state: "vigente", saidOn: "2026-10-24", weeksSaid: 12, weeksToday: 12 })
    expect(pregnancyToday(byFur, "2026-11-07")?.weeksToday).toBe(14)
  })

  it("lo guardado antes sin fecha toma la del día en que se anotó ese «sí», por las versiones de la entrevista", () => {
    const yes = { antecedentesPersonales: { embarazo: true, semanasEmbarazo: 30 } }
    // De la más nueva a la más antigua: el «sí» de 30 semanas está desde el 12 nov; antes decía que no.
    const versions = [
      { answers: { ...yes, antecedentesPersonales: { ...yes.antecedentesPersonales, cirugias: "Apendicitis" } }, day: "2026-11-20" },
      { answers: yes, day: "2026-11-12" },
      { answers: { antecedentesPersonales: { embarazo: false } }, day: "2026-10-01" },
    ]
    expect(legacyPregnancySaidOn(versions)).toBe("2026-11-12")
    // Una gestante de 30 semanas anotada ayer no pierde su alerta: hoy siguen siendo 30, y en dos semanas, 32.
    expect(pregnancyToday(yes, "2026-11-13", { legacySaidOn: "2026-11-12" })).toEqual({
      state: "vigente",
      saidOn: "2026-11-12",
      weeksSaid: 30,
      weeksToday: 30,
    })
    expect(pregnancyToday(yes, "2026-11-26", { legacySaidOn: "2026-11-12" })?.weeksToday).toBe(32)
    // Si las semanas cambiaron, cuenta desde que se dijeron las vigentes.
    expect(
      legacyPregnancySaidOn([
        { answers: yes, day: "2026-11-12" },
        { answers: { antecedentesPersonales: { embarazo: true, semanasEmbarazo: 20 } }, day: "2026-09-03" },
      ]),
    ).toBe("2026-11-12")
    // Lo que ya trae su fecha no la toma de las versiones; sin versiones no hay fecha que decir.
    expect(legacyPregnancySaidOn([{ answers: { embarazoLactancia: { embarazo: { estado: "si", fecha: "2026-11-13" } } }, day: "2026-11-20" }])).toBeNull()
    expect(legacyPregnancySaidOn([])).toBeNull()
  })

  it("un «no» y lo no respondido no son un embarazo", () => {
    expect(pregnancyToday({ embarazoLactancia: { embarazo: { estado: "no", fecha: "2026-11-13" } } }, "2026-11-13")).toBeNull()
    expect(pregnancyToday({ antecedentesPersonales: { embarazo: false } }, "2026-11-13")).toBeNull()
    expect(pregnancyToday({}, "2026-11-13")).toBeNull()
    expect(pregnancyToday(null, "2026-11-13")).toBeNull()
  })

  it("lo del registro entra con el día en que se dijo y lo demás de «Personales» sigue igual", () => {
    expect(declaredPregnancy({ embarazo: true, semanasEmbarazo: 30, cirugias: "Apendicitis" }, "2026-11-13")).toEqual({
      statement: { estado: "si", fecha: "2026-11-13", semanas: 30 },
      rest: { cirugias: "Apendicitis" },
    })
    expect(declaredPregnancy({ embarazo: false, semanasEmbarazo: 3 }, "2026-11-13").statement).toEqual({ estado: "no", fecha: "2026-11-13" })
    expect(declaredPregnancy({ cirugias: "Apendicitis" }, "2026-11-13").statement).toBeNull()
  })

  it("al guardar la entrevista queda una sola forma y la fecha es obligatoria", () => {
    const checked = checkInterviewPregnancy(
      {
        antecedentesPersonales: { embarazo: true, semanasEmbarazo: 20, cirugias: "Apendicitis" },
        embarazoLactancia: { embarazo: { estado: "si", fecha: "2026-11-13", semanas: 30 } },
      },
      "2026-11-13",
    )
    expect(checked).toEqual({
      ok: true,
      value: {
        antecedentesPersonales: { cirugias: "Apendicitis" },
        embarazoLactancia: { embarazo: { estado: "si", fecha: "2026-11-13", semanas: 30 } },
      },
    })
    expect(checkInterviewPregnancy({ embarazoLactancia: { embarazo: { estado: "si" } } }, "2026-11-13")).toMatchObject({
      ok: false,
      error: "Embarazo: falta la fecha en que se dijo",
      field: "embarazoLactancia.embarazo.fecha",
    })
    // Un 30 de febrero no falta: no existe (QA del 14 nov).
    expect(
      checkInterviewPregnancy({ embarazoLactancia: { embarazo: { estado: "si", fecha: "2026-02-30" } } }, "2026-11-13"),
    ).toMatchObject({ ok: false, error: "Embarazo: esa fecha no existe", field: "embarazoLactancia.embarazo.fecha" })
    expect(
      checkInterviewPregnancy({ embarazoLactancia: { embarazo: { estado: "si", fecha: "2026-11-14" } } }, "2026-11-13"),
    ).toMatchObject({ ok: false, field: "embarazoLactancia.embarazo.fecha" })
    expect(
      checkInterviewPregnancy({ embarazoLactancia: { embarazo: { estado: "si", fecha: "2026-11-13", semanas: 50 } } }, "2026-11-13"),
    ).toMatchObject({ ok: false, field: "embarazoLactancia.embarazo.semanas" })
    // Un «no» no lleva semanas.
    expect(
      checkInterviewPregnancy({ embarazoLactancia: { embarazo: { estado: "no", fecha: "2026-11-13", semanas: 12 } } }, "2026-11-13"),
    ).toEqual({ ok: true, value: { embarazoLactancia: { embarazo: { estado: "no", fecha: "2026-11-13" } } } })
    // Sin embarazo en la entrevista, queda como llegó (lo guardado antes no se toca solo).
    const before = { antecedentesPersonales: { embarazo: true } }
    expect(checkInterviewPregnancy(before, "2026-11-13")).toEqual({ ok: true, value: before })
  })
})

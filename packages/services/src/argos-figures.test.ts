import { describe, expect, it } from "vitest"
import {
  type ArgosNames,
  argosFiguresOf,
  argosFiguresText,
  compileArgosFigure,
  matchArgosName,
} from "./argos-figures.js"
import { argosPlaceholders } from "./argos-period.js"
import { reviewArgosQuery } from "./argos-query.js"

const NAMES: ArgosNames = {
  sedes: ["Sede Miraflores", "Sede San Isidro", "Sede Surco"],
  equipo: ["Dra. Ana Torres", "Luis Prado"],
  atienden: ["Dra. Ana Torres", "Luis Prado"],
  especialidades: ["Cirugía oral", "Ortodoncia y Ortopedia Maxilar"],
  servicios: [
    { name: "Control de ortodoncia", specialty: "Ortodoncia y Ortopedia Maxilar" },
    { name: "Exodoncia simple", specialty: "Cirugía oral" },
    { name: "Exodoncia de pieza impactada en hueso", specialty: "Cirugía oral" },
  ],
  productos: ["Enjuague bucal"],
  promociones: ["Blanqueamiento 2×1"],
}

/** Las palabras de odentIA en las cifras. */
const WORDS = { productName: "odentIA", recallMonths: 6 }
const compile = (ask: Parameters<typeof compileArgosFigure>[0], compare = false) =>
  compileArgosFigure(ask, { key: "gestion", compare, names: NAMES, words: WORDS })

describe("las cifras oficiales de Argos", () => {
  it("una cifra se arma con los huecos del periodo y la sede, y el revisor la acepta", () => {
    const out = compile({ cifra: "cobrado" })
    if ("problem" in out) throw new Error(out.problem)
    expect(out.column).toBe("cobrado_dinero")
    expect(out.sql).toContain("from cobros")
    expect([...argosPlaceholders(out.sql)].sort()).toEqual(["desde", "hasta", "sede"])
    expect(reviewArgosQuery(out.sql).ok).toBe(true)
  })

  it("por especialidad usa lo pagado de cada venta, y el nombre escrito se cambia por el de la clínica", () => {
    const out = compile({
      cifra: "cobrado",
      por: ["profesional"],
      filtros: { especialidad: ["ortodoncia"] },
    })
    if ("problem" in out) throw new Error(out.problem)
    expect(out.sql).toContain("from pagos_por_venta")
    expect(out.sql).toContain("especialidad = any(array['Ortodoncia y Ortopedia Maxilar'])")
    expect(out.resolved).toEqual([
      { written: "ortodoncia", name: "Ortodoncia y Ortopedia Maxilar" },
    ])
    expect(out.how).toMatch(/Separado por profesional\. Solo Ortodoncia y Ortopedia Maxilar\.$/)
    expect(reviewArgosQuery(out.sql).ok).toBe(true)
  })

  it("un nombre que la clínica no tiene vuelve al modelo con los que sí tiene; uno que está en varios, los toma todos", () => {
    const missing = compile({ cifra: "cobrado", filtros: { especialidad: ["implantes"] } })
    expect("problem" in missing && missing.problem).toMatch(
      /«implantes» no es una especialidad de la clínica; son: Cirugía oral, Ortodoncia y Ortopedia Maxilar/,
    )
    const many = compile({ cifra: "tratamientos_hechos", filtros: { servicio: ["exodoncia"] } })
    if ("problem" in many) throw new Error(many.problem)
    expect(many.sql).toContain(
      "servicio = any(array['Exodoncia simple', 'Exodoncia de pieza impactada en hueso'])",
    )
    expect(matchArgosName("surco", NAMES.sedes)).toEqual({ name: "Sede Surco" })
    expect(matchArgosName("Blanqueamiento 2x1", NAMES.promociones)).toEqual({ name: "Blanqueamiento 2×1" })
    expect(matchArgosName("SAN ISIDRO", NAMES.sedes)).toEqual({ name: "Sede San Isidro" })
    // Una sede elegida en la pregunta reemplaza a la de arriba.
    const two = compile({
      cifra: "ticket_promedio",
      por: ["sede"],
      filtros: { sede: ["Surco", "Miraflores"] },
    })
    if ("problem" in two) throw new Error(two.problem)
    expect(two.sql).toContain("sede = any(array['Sede Surco', 'Sede Miraflores'])")
    expect(two.sql).not.toContain(":sede")
  })

  it("compara con lo de antes en la misma fila, con su variación; y da la parte del total", () => {
    const out = compile({ cifra: "cobrado", por: ["medio"], parte_del_total: true }, true)
    if ("problem" in out) throw new Error(out.problem)
    expect(out.sql).toContain("coalesce(antes.v, 0) as cobrado_antes_dinero")
    expect(out.sql).toContain("as variacion_pct")
    expect(out.sql).toContain("as parte_pct")
    expect(out.sql).toContain("ahora left join antes using (medio)")
    expect([...argosPlaceholders(out.sql)].sort()).toEqual([
      "desde",
      "desde_antes",
      "hasta",
      "hasta_antes",
      "sede",
    ])
    expect(reviewArgosQuery(out.sql).ok).toBe(true)
    // Un porcentaje no se suma: sin variación en % ni parte del total.
    const rate = compile(
      { cifra: "no_vinieron", por: ["profesional"], parte_del_total: true },
      true,
    )
    if ("problem" in rate) throw new Error(rate.problem)
    expect(rate.sql).toContain("no_vinieron_antes_pct")
    expect(rate.sql).not.toContain("variacion_pct")
    expect(rate.sql).not.toContain("parte_pct")
  })

  it("por mes, semana o día, lo de antes se corre a las fechas de ahora: enero con el enero del año anterior", () => {
    const out = compile({ cifra: "cobrado", por: ["mes"] }, true)
    if ("problem" in out) throw new Error(out.problem)
    expect(out.sql).toContain("antes as (select date_trunc('month', (dia + age(:dia_desde, :dia_desde_antes))::date)::date as mes")
    expect(out.sql).toContain("ahora as (select date_trunc('month', dia)::date as mes")
    expect(out.sql).toContain("ahora left join antes using (mes)")
    expect(reviewArgosQuery(out.sql).ok).toBe(true)
    // El día de la semana ya coincide: no se corre.
    const weekdays = compile({ cifra: "atendidas", por: ["dia_semana"] }, true)
    if ("problem" in weekdays) throw new Error(weekdays.problem)
    expect(weekdays.sql).not.toContain("age(")
  })

  it("lo que la cifra no admite se le dice al modelo, sin calcular", () => {
    expect(compile({ cifra: "no_existe" })).toMatchObject({
      problem: expect.stringMatching(/no es una cifra oficial/),
    })
    expect(compile({ cifra: "gastos", por: ["profesional"] })).toMatchObject({
      problem: expect.stringMatching(
        /Lo gastado se separa y filtra solo por mes, semana, dia, dia_semana, sede, categoria/,
      ),
    })
    expect(compile({ cifra: "cobrado", por: ["color"] })).toMatchObject({
      problem: expect.stringMatching(/«color» no es un corte/),
    })
    expect(compile({ cifra: "te_deben" }, true)).toMatchObject({
      problem: expect.stringMatching(/es a hoy/),
    })
  })

  it("en el tiempo va en su orden; por día de la semana, de lunes a domingo", () => {
    const months = compile({ cifra: "atendidas", por: ["mes"] })
    if ("problem" in months) throw new Error(months.problem)
    expect(months.sql).toContain("date_trunc('month', dia)::date as mes")
    expect(months.sql).toMatch(/order by mes$/)
    const days = compile({ cifra: "horas_libres", por: ["dia_semana", "hora"] })
    if ("problem" in days) throw new Error(days.problem)
    expect(days.sql).toContain("from agenda_por_hora")
    expect(days.sql).toContain("dia >= :dia_desde and dia < :dia_hasta")
    expect(days.sql).toMatch(/order by case dia_semana when 'lunes' then 1/)
  })

  it("cada rol ve las cifras de las vistas que lee", () => {
    const reception = argosFiguresOf("recepcion").map((figure) => figure.key)
    expect(reception).toContain("atendidas")
    expect(reception).not.toContain("cobrado")
    expect(argosFiguresText("recepcion", WORDS)).not.toContain("- cobrado:")
    expect(argosFiguresOf("caja").map((figure) => figure.key)).toContain("cobrado")
    expect(
      compileArgosFigure({ cifra: "cobrado" }, { key: "recepcion", compare: false, names: NAMES, words: WORDS }),
    ).toMatchObject({ problem: expect.stringMatching(/no es una cifra oficial que puedas pedir/) })
  })

  it("toda cifra con fecha se separa por día de la semana, de lunes a domingo", () => {
    const out = compile({ cifra: "cobrado", por: ["dia_semana"] })
    if ("problem" in out) throw new Error(out.problem)
    expect(out.sql).toContain("from cobros")
    expect(out.sql).toContain("[extract(isodow from dia)::int] as dia_semana")
    expect(out.sql).toMatch(/order by case dia_semana when 'lunes' then 1/)
    expect(reviewArgosQuery(out.sql).ok).toBe(true)
    // «¿Qué días cobramos más?»: de mayor a menor.
    const most = compile({ cifra: "cobrado", por: ["dia_semana"], orden: "mayor" })
    if ("problem" in most) throw new Error(most.problem)
    expect(most.sql).toMatch(/order by ahora\.v desc, dia_semana$/)
  })
})

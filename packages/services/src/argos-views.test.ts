/**
 * Argos sobre las vistas del negocio (ADR 0075): cada llave lee solo las vistas
 * de su rol, nunca tablas ni otra clínica, y no puede cambiar de clínica; el
 * revisor rechaza lo que no es una lectura de las vistas. Y el cuadre: cada
 * cifra de Reportes que dan las vistas sale igual que en la pantalla.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import { professionalSchedule, scheduleBlock } from "@odentia/db/schema/availability"
import { encounter, encounterProcedure, orgSpecialty, patientCharge, serviceCatalog } from "@odentia/db/schema/clinical"
import { professionalSpecialty } from "@odentia/db/schema/clinical-forms"
import { branch } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { argosEmptyHoleProblem, argosNamesText, argosSentenceProblem, fillArgosSentence } from "./argos-answer.js"
import { ARGOS_CATALOG, argosCatalogText, argosViewsOf } from "./argos-catalog.js"
import { listArgosNames } from "./argos-figures.js"
import { ArgosQueryError, reviewArgosQuery, runArgosQuery } from "./argos-query.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createExpense, setCommissionRate } from "./finance.js"
import { createPaymentMethod } from "./payment-methods.js"
import { collectCharge, createCharge, refundCredit, voidTicket } from "./payments.js"
import { computeFigure, type FigureContext } from "./report-figures.js"
import { collectedByMethod } from "./report-finance.js"
import { reportScope } from "./report-scope.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"

setupTestDb()

const one = async (orgId: string, query: string, memberRole = "owner") =>
  Number((await runArgosQuery(appDb, { orgId, memberRole, query })).rows[0]?.v ?? 0)

/** Lo que la pantalla dice de una cifra en un periodo, con la ventana para pedírselo a las vistas. */
async function screen(orgId: string, period: string, figure: string, branchId?: string) {
  return withOrgContext(appDb, orgId, async (tx) => {
    const scope = await reportScope(tx, orgId, { period, ...(branchId ? { branchId } : {}) }, new Date())
    const ctx: FigureContext = { tx, orgId, scope, billing: true }
    const result = await computeFigure(ctx, { figure, group: "total" })
    return { value: result.total.value ?? 0, from: scope.window.start.toISOString(), to: scope.window.end.toISOString() }
  })
}

describe("las llaves de Argos", () => {
  it("cada rol lee solo sus vistas, nunca tablas, otra clínica ni otro app.org_id", async () => {
    await insertTestPatients(ownerDb, [
      { organizationId: "org_a", displayName: "Ana de la A", patientNumber: 9001 },
      { organizationId: "org_b", displayName: "Beto de la B", patientNumber: 9001 },
    ])
    expect(await one("org_a", "select count(*) as v from pacientes where nombre = 'Ana de la A'")).toBe(1)
    expect(await one("org_a", "select count(*) as v from pacientes where nombre = 'Beto de la B'")).toBe(0)
    expect(await one("org_b", "select count(*) as v from pacientes where nombre = 'Beto de la B'", "reception")).toBe(1)

    // Recepción no ve caja; quien no tiene rol no pregunta.
    await expect(runArgosQuery(appDb, { orgId: "org_a", memberRole: "reception", query: "select count(*) from cobros" })).rejects.toMatchObject({
      code: "PERMISO",
    })
    await expect(runArgosQuery(appDb, { orgId: "org_a", memberRole: "member", query: "select 1" })).rejects.toBeInstanceOf(ArgosQueryError)
    // El error que vuelve al modelo dice qué pasó sin el valor de la base: el nombre del paciente no viaja.
    const cast = await runArgosQuery(appDb, { orgId: "org_a", memberRole: "owner", query: "select nombre::int as v from pacientes where nombre = 'Ana de la A'" }).catch((error: unknown) => error)
    expect(cast).toBeInstanceOf(ArgosQueryError)
    expect((cast as ArgosQueryError).message).not.toContain("Ana de la A")
    expect((cast as ArgosQueryError).message).toContain("no se pudo convertir")
    // Lo que nombra el modelo sí se le dice, para que corrija.
    await expect(runArgosQuery(appDb, { orgId: "org_a", memberRole: "owner", query: "select monto from cobros" })).rejects.toThrow(/monto/)

    // Aunque el revisor fallara, la llave no lee tablas ni cambia de clínica.
    const raw = (statement: string) =>
      appDb.transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.org_id', 'org_a', true)`)
        await tx.execute(sql.raw("set local role argos_gestion"))
        return tx.execute(sql.raw(statement))
      })
    await expect(raw("select count(*) from public.patient")).rejects.toThrow()
    await expect(raw("select set_config('app.org_id', 'org_b', true)")).rejects.toThrow()
    await expect(raw("select count(*) from argos.agenda_base")).rejects.toThrow()
    // El rol app sigue fijando su clínica.
    expect(await withOrgContext(appDb, "org_a", async () => true)).toBe(true)
  })

  it("el catálogo que lee el modelo es el de la base: vistas, columnas en orden y llaves", async () => {
    const columns = await ownerDb.execute<{ view: string; names: string }>(sql`
      select table_name as view, string_agg(column_name, ',' order by ordinal_position) as names
      from information_schema.columns where table_schema = 'argos' and table_name <> 'agenda_base' group by table_name`)
    const described = (text: string) => {
      // Las columnas van separadas por comas fuera de los paréntesis; cada una empieza con su nombre.
      const names: string[] = []
      let depth = 0
      let current = ""
      for (const char of `${text},`) {
        if (char === "(") depth += 1
        if (char === ")") depth -= 1
        if (char === "," && depth === 0) {
          names.push(current.trim().split(/[\s(]/)[0] ?? "")
          current = ""
        } else current += char
      }
      return names.join(",")
    }
    expect(Object.fromEntries([...columns].map((row) => [row.view, row.names]))).toEqual(
      Object.fromEntries(ARGOS_CATALOG.map((view) => [view.name, described(view.columns)])),
    )
    for (const key of ["gestion", "recepcion", "clinico", "caja"] as const) {
      const granted = await ownerDb.execute<{ view: string }>(sql`
        select c.relname as view from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'argos' and has_table_privilege(${`argos_${key}`}, c.oid, 'select')`)
      expect([...granted].map((row) => row.view).sort(), key).toEqual(argosViewsOf(key).map((view) => view.name).sort())
    }
  })

  it("cada llave recibe sus vistas, y solo esas", () => {
    const cashier = argosCatalogText("caja")
    expect(cashier).toContain("\ncobros:")
    expect(cashier).not.toContain("\ncomisiones:")
    expect(cashier).not.toContain("\ncitas:")
    expect(cashier).toContain("Lo que odentIA no registra")
  })

  it("la frase sale con el formato de la clínica: meses con nombre, números con su etiqueta y «y N más»", () => {
    const zone = { locale: "es-PE", currency: "PEN", timezone: "America/Lima" }
    const months = {
      columns: [
        { name: "mes", kind: "date" as const },
        { name: "pacientes", kind: "number" as const },
      ],
      rows: Array.from({ length: 14 }, (_, index) => ({ mes: `${2026 + Math.floor(index / 12)}-${String((index % 12) + 1).padStart(2, "0")}-01`, pacientes: index })),
      truncated: false,
    }
    // Un año entero entra en la lista; lo que pasa de 12 se cuenta.
    const filled = fillArgosSentence("Por mes: {lista}.", months, zone)
    expect(filled.text).toMatch(/^Por mes: enero de 2026 \(pacientes: 0\); febrero de 2026 \(pacientes: 1\); .*diciembre de 2026 \(pacientes: 11\) y 2 más\.$/)
    const money = { columns: [{ name: "categoria", kind: "text" as const }, { name: "monto_dinero", kind: "number" as const }], rows: [{ categoria: "Alquiler", monto_dinero: 11300 }], truncated: false }
    expect(fillArgosSentence("{lista}", money, zone).text).toMatch(/^Alquiler \(S\/\s?11,300\.00\)$/)
    // Dos montos en la misma fila llevan su nombre: si no, no se sabe cuál es cuál.
    const branches = {
      columns: [{ name: "sede", kind: "text" as const }, { name: "cobrado_dinero", kind: "number" as const }, { name: "dejo_dinero", kind: "number" as const }],
      rows: [{ sede: "Miraflores", cobrado_dinero: 284045, dejo_dinero: 15946.5 }],
      truncated: false,
    }
    expect(fillArgosSentence("{lista}", branches, zone).text).toMatch(/^Miraflores \(cobrado: S\/\s?284,045\.00, dejo: S\/\s?15,946\.50\)$/)
    const rate = { columns: [{ name: "cobrado_pct", kind: "number" as const }], rows: [{ cobrado_pct: 88 }], truncated: false }
    expect(fillArgosSentence("Se cobró el {cobrado_pct}% de lo cargado; {cobrado_pct} %.", rate, zone).text).toBe("Se cobró el 88 % de lo cargado; 88 %.")
    expect(fillArgosSentence("Desde {desde}.", { columns: [{ name: "desde", kind: "date" }], rows: [{ desde: "2026-10-01" }], truncated: false }, zone).text).toBe("Desde 1 de octubre de 2026.")
    // Una columna que se llama como el hueco reservado es lo que se contó: no la cantidad de filas.
    expect(fillArgosSentence("Hay {filas} presupuestos.", { columns: [{ name: "filas", kind: "number" }], rows: [{ filas: 28 }], truncated: false }, zone).text).toBe("Hay 28 presupuestos.")
    // Una variación dice si sube.
    expect(fillArgosSentence("Cambiaron {variacion_pct}.", { columns: [{ name: "variacion_pct", kind: "number" }], rows: [{ variacion_pct: 1 }], truncated: false }, zone).text).toBe("Cambiaron +1 %.")
    // La hora del día se dice como hora, y el total de todas las filas va en la frase, no en cada una.
    const hours = { columns: [{ name: "hora", kind: "number" as const }, { name: "libres", kind: "number" as const }], rows: [{ hora: 9, libres: 4 }], truncated: false }
    expect(fillArgosSentence("{lista}", hours, zone).text).toBe("09:00 (libres: 4)")
    // Las horas, los días y los minutos son unidades: se dicen con su palabra, en singular si es uno.
    const team = { columns: [{ name: "profesional", kind: "text" as const }, { name: "horas", kind: "number" as const }], rows: [{ profesional: "Dra. Ana Torres", horas: 47 }], truncated: false }
    expect(fillArgosSentence("{lista}", team, zone).text).toBe("Dra. Ana Torres (47 horas)")
    const away = { columns: [{ name: "profesional", kind: "text" as const }, { name: "dias", kind: "number" as const }], rows: [{ profesional: "Dra. Ana Torres", dias: 1 }], truncated: false }
    expect(fillArgosSentence("{lista}", away, zone).text).toBe("Dra. Ana Torres (1 día)")
    const owed = {
      columns: [
        { name: "paciente", kind: "text" as const },
        { name: "saldo_dinero", kind: "number" as const },
        { name: "total_general", kind: "number" as const },
        { name: "total_general_dinero", kind: "number" as const },
      ],
      rows: [{ paciente: "Lorena", saldo_dinero: 1080, total_general: 211, total_general_dinero: 52785 }],
      truncated: true,
    }
    expect(fillArgosSentence("{total_general} te deben {total_general_dinero}: {lista}.", owed, zone).text).toMatch(/^211 te deben S\/\s?52,785\.00: Lorena \(S\/\s?1,080\.00\) y más\.$/)
  })

  it("una frase con la lista dos veces o en medio no se lee: se corrige", () => {
    expect(argosSentenceProblem("La mayor fue {lista} y la menor {lista}.")).toMatch(/una sola vez/)
    expect(argosSentenceProblem("Del 1 al 20 de octubre, {lista} de los pacientes atendidos.")).toMatch(/al final/)
    expect(argosSentenceProblem("Los que más deben: {lista}.")).toBeNull()
    expect(argosSentenceProblem("Este mes se cobró {cobrado_dinero}.")).toBeNull()
    // El mismo hueco dos veces es la misma primera fila: con varias filas no dice lo que parece.
    expect(argosSentenceProblem("Nuevos: {porcentaje_pct}; recurrentes: {porcentaje_pct}.", 2)).toMatch(/dos veces/)
    expect(argosSentenceProblem("Se cobró {cobrado_dinero}; sí, {cobrado_dinero}.", 1)).toBeNull()
  })

  it("un hueco que vino sin valor se corrige antes de mostrarse, sin decirle al modelo ningún dato", () => {
    const result = {
      columns: [
        { name: "surco_dinero", kind: "number" as const },
        { name: "miraflores_dinero", kind: "number" as const },
      ],
      rows: [{ surco_dinero: null, miraflores_dinero: 223.87 }],
    }
    const problem = argosEmptyHoleProblem("El ticket de Surco fue {surco_dinero} y el de Miraflores {miraflores_dinero}.", result)
    expect(problem).toMatch(/^\{surco_dinero\} vino sin valor/)
    expect(problem).not.toMatch(/223/)
    expect(argosEmptyHoleProblem("El de Miraflores fue {miraflores_dinero}.", result)).toBeNull()
    // Sin filas habla la frase vacía: no hay hueco que revisar.
    expect(argosEmptyHoleProblem("Fue {surco_dinero}.", { ...result, rows: [] })).toBeNull()
  })

  it("lo que no tiene valor nunca sale primero", async () => {
    const review = reviewArgosQuery("select nombre from pacientes where nombre <> 'desc' order by ultima_atencion desc, nombre desc nulls first")
    expect(review).toMatchObject({ ok: true, sql: "select nombre from pacientes where nombre <> 'desc' order by ultima_atencion desc nulls last, nombre desc nulls first" })
    const { rows } = await runArgosQuery(appDb, { orgId: "org_a", memberRole: "owner", query: "select v from unnest(array[1, null, 3]) as v order by v desc" })
    expect(rows.map((row) => row.v)).toEqual([3, 1, null])
    // Un LIMIT propio más largo que la lista que llega a su tope también cortó: no se sabe cuántas faltan.
    const cut = await runArgosQuery(appDb, { orgId: "org_a", memberRole: "owner", query: "select v from unnest(array[1,2,3,4,5,6,7,8,9,10,11,12,13,14]) as v order by v limit 13" })
    expect(cut).toMatchObject({ truncated: true })
    const top = await runArgosQuery(appDb, { orgId: "org_a", memberRole: "owner", query: "select v from unnest(array[1,2,3,4,5,6]) as v order by v limit 5" })
    expect(top).toMatchObject({ truncated: false })
  })

  it("el revisor deja pasar una lectura de las vistas y rechaza lo demás", () => {
    expect(reviewArgosQuery("select sum(importe) as total from argos.cobros where dia >= date '2026-10-01';")).toMatchObject({ ok: true })
    expect(reviewArgosQuery("with x as (select dia, count(*) n from citas group by dia) select max(n) from x")).toMatchObject({ ok: true })
    // El FROM de extract o substring es de la función, no una vista.
    expect(reviewArgosQuery("select extract(day from c.inicio) as d, count(*) as n from citas c where extract(dow from current_date) = 1 group by 1")).toMatchObject({ ok: true })
    expect(reviewArgosQuery("select extract(day from now()) as d from public.patient")).toMatchObject({ ok: false })
    expect(reviewArgosQuery("select count(*) from citas where sede = 'Sede E'")).toMatchObject({ ok: true })
    // La mediana: «group» de `within group (…)` no es una función.
    expect(reviewArgosQuery("select percentile_cont(0.5) within group (order by espera_min) as espera from citas")).toMatchObject({ ok: true })
    for (const bad of [
      "select * from public.patient",
      "select * from patient",
      "select set_config('app.org_id', 'x', true)",
      "select pg_sleep(10)",
      "select * from pg_roles",
      "select 1; select 2",
      "insert into argos.citas values (1)",
      "select * from citas -- comentario",
      "select $$x$$",
      'select * from "citas"',
      "select * into nueva from citas",
      "update citas set estado = 'x'",
      "select count(*) from generate_series(1, 2000000000)",
      "select E'a' as x from citas",
      "select U&'a' as x from citas",
    ])
      expect(reviewArgosQuery(bad), bad).toMatchObject({ ok: false })
  })
})

describe("cuadre con Reportes", () => {
  it("dinero del mes: lo cobrado, comisiones, gastos, lo que deja y lo que deben", async () => {
    const f = await clinicalFixture()
    // Una segunda fila de miembro de la misma persona: su comisión no se cuenta dos veces.
    await ownerDb.insert(member).values({ id: randomUUID(), organizationId: "org_a", userId: f.actor, role: "dentist", createdAt: new Date() })
    const [site] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede ${randomUUID()}` }).returning()
    const branchId = site!.id
    const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: `Efectivo ${randomUUID()}`, typeCode: "10" }))
    const procedure = async (priceCents: number) => {
      const [row] = await ownerDb
        .insert(encounterProcedure)
        .values({ organizationId: "org_a", encounterId: f.encounter.id, serviceId: f.service.id, description: "Tratamiento", priceCents, currency: "PEN", createdBy: f.actor })
        .returning()
      return row!
    }
    const first = await procedure(40_000)
    const second = await procedure(20_000)
    await ownerDb
      .update(encounter)
      .set({ status: "finalizada", finalizedAt: new Date(), signerName: "Clínico", signerRegistration: "12345" })
      .where(eq(encounter.id, f.encounter.id))
    const chargeA = await f.run((tx) => createCharge(tx, ...f.args, { encounterProcedureId: first.id }))
    const chargeB = await f.run((tx) => createCharge(tx, ...f.args, { encounterProcedureId: second.id }))
    await f.run((tx) => setCommissionRate(tx, "org_a", f.actor, { professionalUserId: f.actor, rateBps: 3000 }))
    const collect = (chargeId: string, amountCents: number) =>
      f.run((tx) => collectCharge(tx, ...f.args, { branchId, chargeIds: [chargeId], payments: [{ paymentMethodId: cash.id, amountCents }], requestId: randomUUID() }))
    const paid = await collect(chargeA.id, 40_000)
    await collect(chargeB.id, 20_000)
    // Se anula el primer cobro: vuelve a deberse y no es cobrado ni comisión.
    await f.run((tx) => voidTicket(tx, "org_a", f.actor, f.patient.id, paid.ticket.id, { reason: "Se cobró a otra persona", allowPostClose: false }))
    await f.run((tx) => createExpense(tx, "org_a", f.actor, { branchId, category: "Materiales", concept: "Guantes", amountCents: 7_000 }))
    // Otra persona debe desde hace 45 días: deuda vencida.
    const [late] = await insertTestPatients(ownerDb, { organizationId: "org_a", displayName: "Debe de antes", patientNumber: 9101 })
    await ownerDb.insert(patientCharge).values({
      organizationId: "org_a",
      patientId: late!.id,
      branchId,
      description: "Concepto antiguo",
      amountCents: 12_000,
      currency: "PEN",
      createdAt: new Date(Date.now() - 45 * 86_400_000),
    })

    const inMonth = async (figure: string, query: (from: string, to: string) => string) => {
      const pantalla = await screen("org_a", "este_mes", figure)
      const vistas = await one("org_a", query(pantalla.from, pantalla.to))
      return { pantalla: Math.round(pantalla.value), vistas: Math.round(vistas) }
    }
    const range = (column: string, from: string, to: string) => `${column} >= timestamptz '${from}' and ${column} < timestamptz '${to}'`
    const cobrado = await inMonth("cobrado", (from, to) => `select sum(importe) * 100 as v from cobros where ${range("momento", from, to)}`)
    expect(cobrado.vistas).toBe(cobrado.pantalla)
    expect(cobrado.vistas).toBe(20_000)
    const comisiones = await inMonth("comisiones", (from, to) => `select sum(comision) * 100 as v from comisiones where ${range("momento", from, to)}`)
    expect(comisiones.vistas).toBe(comisiones.pantalla)
    const gastos = await inMonth("gastos", (from, to) => `select sum(monto) * 100 as v from gastos where tipo <> 'pago_de_comisiones' and ${range("momento", from, to)}`)
    expect(gastos.vistas).toBe(gastos.pantalla)
    const queda = await inMonth(
      "lo_que_deja",
      (from, to) => `select ((select coalesce(sum(importe), 0) from cobros where ${range("momento", from, to)})
        - (select coalesce(sum(comision), 0) from comisiones where ${range("momento", from, to)})
        - (select coalesce(sum(monto), 0) from gastos where tipo <> 'pago_de_comisiones' and ${range("momento", from, to)})) * 100 as v`,
    )
    expect(queda.vistas).toBe(queda.pantalla)
    const deben = await inMonth("te_deben", () => "select sum(saldo) * 100 as v from deudas")
    expect(deben.vistas).toBe(deben.pantalla)
    const vencido = await inMonth("deuda_vencida", () => "select sum(saldo) * 100 as v from deudas where vencida")
    expect(vencido.vistas).toBe(vencido.pantalla)
    expect(vencido.vistas).toBe(12_000)
  })

  it("lo cobrado por medio de pago resta anulaciones y devoluciones del medio del pago, como Reportes", async () => {
    const f = await clinicalFixture()
    const [site] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede ${randomUUID()}` }).returning()
    const branchId = site!.id
    const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: `Efectivo ${randomUUID()}`, typeCode: "10" }))
    const card = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: `Tarjeta ${randomUUID()}`, typeCode: "48" }))
    const advance = (paymentMethodId: string, amountCents: number) =>
      f.run((tx) => collectCharge(tx, ...f.args, { branchId, advanceCents: amountCents, payments: [{ paymentMethodId, amountCents }], requestId: randomUUID() }))
    const voided = await advance(cash.id, 30_000)
    await advance(cash.id, 10_000)
    await advance(card.id, 8_000)
    await f.run((tx) => voidTicket(tx, "org_a", f.actor, f.patient.id, voided.ticket.id, { reason: "Se cobró dos veces", allowPostClose: false }))
    // Se devuelve parte de lo que está a favor: resta del medio del pago devuelto.
    await f.run((tx) => refundCredit(tx, ...f.args, { branchId, amountCents: 3_000, reason: "Ya no se atiende" }))

    const window = await screen("org_a", "este_mes", "cobrado")
    const pantalla = await withOrgContext(appDb, "org_a", (tx) =>
      collectedByMethod(tx, "org_a", { start: new Date(window.from), end: new Date(window.to) }, { currency: "PEN" }),
    )
    const vistas = await runArgosQuery(appDb, {
      orgId: "org_a",
      memberRole: "owner",
      query: `select medio, sum(importe) * 100 as v from cobros where momento >= timestamptz '${window.from}' and momento < timestamptz '${window.to}' group by medio`,
    })
    const ours = Object.fromEntries(vistas.rows.map((row) => [String(row.medio), Math.round(Number(row.v))]).filter(([, cents]) => cents !== 0))
    expect(ours).toEqual(Object.fromEntries(pantalla.methods.map((row) => [row.label, row.cents])))
    // 10.000 + 8.000 cobrados, el de 30.000 anulado y 3.000 devueltos.
    expect((ours[cash.name] ?? 0) + (ours[card.name] ?? 0)).toBe(15_000)
  })

  it("lo vendido y lo pagado llevan la especialidad del servicio del tratamiento", async () => {
    const f = await clinicalFixture()
    const [specialty] = await ownerDb.insert(orgSpecialty).values({ organizationId: "org_a", key: `endo-${randomUUID()}`, name: `Endodoncia ${randomUUID()}` }).returning()
    await ownerDb.update(serviceCatalog).set({ specialtyId: specialty!.id }).where(eq(serviceCatalog.id, f.service.id))
    const [site] = await ownerDb.insert(branch).values({ organizationId: "org_a", name: `Sede ${randomUUID()}` }).returning()
    const cash = await f.run((tx) => createPaymentMethod(tx, "org_a", f.actor, { name: `Efectivo ${randomUUID()}`, typeCode: "10" }))
    const [done] = await ownerDb
      .insert(encounterProcedure)
      .values({ organizationId: "org_a", encounterId: f.encounter.id, serviceId: f.service.id, description: "Tratamiento", priceCents: 25_000, currency: "PEN", createdBy: f.actor })
      .returning()
    await ownerDb
      .update(encounter)
      .set({ status: "finalizada", finalizedAt: new Date(), signerName: "Clínico", signerRegistration: "12345" })
      .where(eq(encounter.id, f.encounter.id))
    const charge = await f.run((tx) => createCharge(tx, ...f.args, { encounterProcedureId: done!.id }))
    await f.run((tx) =>
      collectCharge(tx, ...f.args, { branchId: site!.id, chargeIds: [charge.id], payments: [{ paymentMethodId: cash.id, amountCents: 25_000 }], requestId: randomUUID() }),
    )
    const of = async (view: string) =>
      (await runArgosQuery(appDb, { orgId: "org_a", memberRole: "owner", query: `select especialidad, importe from ${view} where venta_id = '${charge.id}'` })).rows.map((row) => ({
        especialidad: row.especialidad,
        importe: Number(row.importe),
      }))
    expect(await of("ventas")).toEqual([{ especialidad: specialty!.name, importe: 250 }])
    expect(await of("pagos_por_venta")).toEqual([{ especialidad: specialty!.name, importe: 250 }])
  })

  it("citas y agenda del mes pasado: atendidas, inasistencia, canceladas, pacientes nuevos y agenda ocupada", async () => {
    const orgId = randomUUID()
    await insertOrg(ownerDb, orgId, `argos-${orgId}`)
    const [site] = await ownerDb.insert(branch).values({ organizationId: orgId, name: "Centro" }).returning()
    const [chair] = await ownerDb.insert(scheduleChair).values({ organizationId: orgId, branchId: site!.id, name: "Unidad dental 1" }).returning()
    const dentist = randomUUID()
    await ownerDb.insert(user).values({ id: dentist, name: "Dra. Prueba", email: `${dentist}@argos.test` })
    await ownerDb.insert(member).values({ id: randomUUID(), organizationId: orgId, userId: dentist, role: "dentist", createdAt: new Date() })
    await ownerDb.insert(professionalSchedule).values(
      [1, 2, 3, 4, 5].map((weekday) => ({ organizationId: orgId, branchId: site!.id, dentistUserId: dentist, weekday, startMin: 9 * 60, endMin: 13 * 60, isActive: true, validFrom: "2020-01-01" })),
    )
    const people = await insertTestPatients(ownerDb, [
      { organizationId: orgId, displayName: "Uno", patientNumber: 1 },
      { organizationId: orgId, displayName: "Dos", patientNumber: 2 },
      { organizationId: orgId, displayName: "Tres", patientNumber: 3 },
    ])
    // El mes pasado en Lima (UTC−5) y su primer lunes desde el día 5.
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit" }).formatToParts(new Date())
    const year = Number(parts.find((p) => p.type === "year")?.value)
    const month = Number(parts.find((p) => p.type === "month")?.value)
    const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 }
    let monday = 5
    while (new Date(Date.UTC(previous.year, previous.month - 1, monday, 12)).getUTCDay() !== 1) monday += 1
    const at = (day: number, hour: number) => new Date(Date.UTC(previous.year, previous.month - 1, day, hour + 5))
    const visit = (patient: number, day: number, hour: number, status: string) =>
      ownerDb.insert(appointment).values({
        organizationId: orgId,
        branchId: site!.id,
        patientId: people[patient]!.id,
        dentistUserId: dentist,
        chairId: chair!.id,
        serviceName: "Consulta",
        startsAt: at(day, hour),
        endsAt: at(day, hour + 1),
        durationMin: 60,
        status,
      })
    await visit(0, monday, 9, "atendida")
    await visit(1, monday, 10, "no_asistio")
    await visit(1, monday, 11, "cancelada")
    await visit(0, monday + 2, 9, "atendida")
    await visit(2, monday + 2, 10, "atendida")
    // El martes cerró toda la sede: no cuenta como horario.
    await ownerDb.insert(scheduleBlock).values({ organizationId: orgId, branchId: site!.id, kind: "bloqueo", reason: "Feriado", startsAt: at(monday + 1, 0), endsAt: at(monday + 2, 0) })

    const fromDay = `${previous.year}-${String(previous.month).padStart(2, "0")}-01`
    const compare = async (figure: string, query: (from: string, to: string) => string) => {
      const pantalla = await screen(orgId, "mes_pasado", figure)
      const vistas = await one(orgId, query(pantalla.from, pantalla.to))
      return { pantalla: Math.round(pantalla.value), vistas: Math.round(vistas) }
    }
    const window = (from: string, to: string) => `inicio >= timestamptz '${from}' and inicio < timestamptz '${to}'`
    const atendidas = await compare("atendidas", (from, to) => `select count(*) as v from citas where estado = 'atendida' and ${window(from, to)}`)
    expect(atendidas).toEqual({ pantalla: 3, vistas: 3 })
    const faltaron = await compare(
      "no_vinieron",
      (from, to) => `select 100.0 * count(*) filter (where estado = 'no_vino') / nullif(count(*) filter (where ya_paso), 0) as v from citas where ${window(from, to)}`,
    )
    expect(faltaron.vistas).toBe(faltaron.pantalla)
    expect(faltaron.vistas).toBeGreaterThan(0)
    const canceladas = await compare(
      "canceladas",
      (from, to) => `select 100.0 * count(*) filter (where estado = 'cancelada') / nullif(count(*) filter (where ya_paso), 0) as v from citas where ${window(from, to)}`,
    )
    expect(canceladas.vistas).toBe(canceladas.pantalla)
    expect(canceladas.vistas).toBeGreaterThan(0)
    const nuevos = await compare(
      "pacientes_nuevos",
      (from, to) => `select count(*) as v from pacientes where primera_atencion >= date '${from.slice(0, 10)}' and primera_atencion < (timestamptz '${to}' at time zone 'America/Lima')::date`,
    )
    expect(nuevos).toEqual({ pantalla: 2, vistas: 2 })
    const ocupada = await compare(
      "agenda_ocupada",
      (_, to) =>
        `select 100.0 * sum(minutos_ocupados) / nullif(sum(minutos_disponibles), 0) as v from agenda_por_dia
         where dia >= date '${fromDay}' and dia < (timestamptz '${to}' at time zone 'America/Lima')::date`,
    )
    expect(ocupada.vistas).toBe(ocupada.pantalla)
    expect(ocupada.vistas).toBeGreaterThan(0)
  })

  it("pacientes nuevos de una sede como Reportes, y lo que Argos ve del equipo, sus ausencias, la unidad dental y los nombres", async () => {
    const orgId = randomUUID()
    await insertOrg(ownerDb, orgId, `argos-${orgId}`)
    const [norte, sur] = await ownerDb.insert(branch).values([{ organizationId: orgId, name: "Sede Norte" }, { organizationId: orgId, name: "Sede Sur" }]).returning()
    const [northChair, southChair] = await ownerDb
      .insert(scheduleChair)
      .values([
        { organizationId: orgId, branchId: norte!.id, name: "Unidad dental 1" },
        { organizationId: orgId, branchId: sur!.id, name: "Unidad dental 2" },
      ])
      .returning()
    const dentist = randomUUID()
    await ownerDb.insert(user).values({ id: dentist, name: "Dra. Sur", email: `${dentist}@argos.test` })
    await ownerDb.insert(member).values({ id: randomUUID(), organizationId: orgId, userId: dentist, role: "dentist", createdAt: new Date() })
    const [specialty] = await ownerDb.insert(orgSpecialty).values({ organizationId: orgId, key: "orto", name: "Ortodoncia y Ortopedia Maxilar" }).returning()
    await ownerDb.insert(professionalSpecialty).values({ organizationId: orgId, specialtyId: specialty!.id, userId: dentist })
    await ownerDb.insert(serviceCatalog).values({ organizationId: orgId, name: "Control de ortodoncia", specialtyId: specialty!.id, priceCents: 12_000, currency: "PEN" })
    const people = await insertTestPatients(ownerDb, [
      { organizationId: orgId, displayName: "Primero en el norte", patientNumber: 1 },
      { organizationId: orgId, displayName: "Primero en el sur", patientNumber: 2 },
    ])
    const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Lima", year: "numeric", month: "2-digit" }).formatToParts(new Date())
    const year = Number(parts.find((p) => p.type === "year")?.value)
    const month = Number(parts.find((p) => p.type === "month")?.value)
    const previous = month === 1 ? { year: year - 1, month: 12 } : { year, month: month - 1 }
    const at = (day: number, hour: number) => new Date(Date.UTC(previous.year, previous.month - 1, day, hour + 5))
    const visit = (patient: number, site: string, day: number, hour: number) =>
      ownerDb.insert(appointment).values({
        organizationId: orgId,
        branchId: site,
        patientId: people[patient]!.id,
        dentistUserId: dentist,
        chairId: site === sur!.id ? southChair!.id : northChair!.id,
        serviceName: "Consulta",
        startsAt: at(day, hour),
        endsAt: at(day, hour + 1),
        durationMin: 60,
        status: "atendida",
      })
    // El primero vino al norte y el mismo mes al sur: es nuevo del norte, no del sur.
    await visit(0, norte!.id, 5, 9)
    await visit(0, sur!.id, 12, 9)
    await visit(1, sur!.id, 13, 10)
    await ownerDb.insert(scheduleBlock).values({ organizationId: orgId, branchId: sur!.id, dentistUserId: dentist, kind: "ausencia", reason: "Vacaciones", startsAt: at(20, 0), endsAt: at(23, 0) })

    const pantalla = await screen(orgId, "mes_pasado", "pacientes_nuevos", sur!.id)
    const vistas = await one(
      orgId,
      `select count(*) as v from pacientes where primera_sede = 'Sede Sur' and primera_atencion_en >= timestamptz '${pantalla.from}' and primera_atencion_en < timestamptz '${pantalla.to}'`,
    )
    expect({ pantalla: pantalla.value, vistas }).toEqual({ pantalla: 1, vistas: 1 })

    const rows = async (query: string, memberRole = "owner") => (await runArgosQuery(appDb, { orgId, memberRole, query })).rows
    expect(await rows("select profesional, rol, especialidades from equipo")).toEqual([{ profesional: "Dra. Sur", rol: "odontología", especialidades: "Ortodoncia y Ortopedia Maxilar" }])
    // El motivo es texto libre: no llega; el último día es el que falta, no el del regreso.
    const [away] = await rows("select profesional, sede, primer_dia, ultimo_dia from ausencias")
    expect(away).toMatchObject({ profesional: "Dra. Sur", sede: "Sede Sur" })
    const day = (value: unknown) => (value instanceof Date ? value.toISOString() : String(value)).slice(0, 10)
    expect(day(away?.ultimo_dia) > day(away?.primer_dia)).toBe(true)
    // Caja no ve la agenda: tampoco las ausencias.
    await expect(rows("select count(*) as v from ausencias", "cashier")).rejects.toBeInstanceOf(ArgosQueryError)
    expect(await rows("select distinct unidad_dental from citas where sede = 'Sede Sur'")).toEqual([{ unidad_dental: "Unidad dental 2" }])

    const names = await withOrgContext(appDb, orgId, (tx) => listArgosNames(tx, orgId, "gestion"))
    const text = argosNamesText(names, "gestion")
    expect(text).toContain("Sedes: Sede Norte, Sede Sur.")
    expect(text).toContain("Equipo: Dra. Sur.")
    expect(text).toMatch(/Ortodoncia y Ortopedia Maxilar: Control de ortodoncia\./)
    expect(argosNamesText(await withOrgContext(appDb, orgId, (tx) => listArgosNames(tx, orgId, "clinico")), "clinico")).not.toContain("Productos:")
  })
})

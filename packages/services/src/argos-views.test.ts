/**
 * Argos sobre las vistas del negocio (ADR 0073): cada llave lee solo las vistas
 * de su rol, nunca tablas ni otra clínica, y no puede cambiar de clínica; el
 * revisor rechaza lo que no es una lectura de las vistas. Y el cuadre: cada
 * cifra de Reportes que dan las vistas sale igual que en la pantalla.
 */
import { randomUUID } from "node:crypto"
import { withOrgContext } from "@odentia/db"
import { appointment, scheduleChair } from "@odentia/db/schema/agenda"
import { member, user } from "@odentia/db/schema/auth"
import { professionalSchedule, scheduleBlock } from "@odentia/db/schema/availability"
import { encounter, encounterProcedure, patientCharge } from "@odentia/db/schema/clinical"
import { branch } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { describe, expect, it } from "vitest"
import { ARGOS_CATALOG, argosViewsOf } from "./argos-catalog.js"
import { ArgosQueryError, reviewArgosQuery, runArgosQuery } from "./argos-query.js"
import { clinicalFixture } from "./clinical-test-fixture.js"
import { createExpense, setCommissionRate } from "./finance.js"
import { createPaymentMethod } from "./payment-methods.js"
import { collectCharge, createCharge, voidTicket } from "./payments.js"
import { computeFigure, type FigureContext } from "./report-figures.js"
import { reportScope } from "./report-scope.js"
import { appDb, insertOrg, ownerDb, setupTestDb } from "./test-setup.js"
import { insertTestPatients } from "./test-patient.js"

setupTestDb()

const one = async (orgId: string, query: string, memberRole = "owner") =>
  Number((await runArgosQuery(appDb, { orgId, memberRole, query })).rows[0]?.v ?? 0)

/** Lo que la pantalla dice de una cifra en un periodo, con la ventana para pedírselo a las vistas. */
async function screen(orgId: string, period: string, figure: string) {
  return withOrgContext(appDb, orgId, async (tx) => {
    const scope = await reportScope(tx, orgId, { period }, new Date())
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

  it("lo que no tiene valor nunca sale primero", async () => {
    const review = reviewArgosQuery("select nombre from pacientes where nombre <> 'desc' order by ultima_atencion desc, nombre desc nulls first")
    expect(review).toMatchObject({ ok: true, sql: "select nombre from pacientes where nombre <> 'desc' order by ultima_atencion desc nulls last, nombre desc nulls first" })
    const { rows } = await runArgosQuery(appDb, { orgId: "org_a", memberRole: "owner", query: "select v from unnest(array[1, null, 3]) as v order by v desc" })
    expect(rows.map((row) => row.v)).toEqual([3, 1, null])
  })

  it("el revisor deja pasar una lectura de las vistas y rechaza lo demás", () => {
    expect(reviewArgosQuery("select sum(importe) as total from argos.cobros where dia >= date '2026-10-01';")).toMatchObject({ ok: true })
    expect(reviewArgosQuery("with x as (select dia, count(*) n from citas group by dia) select max(n) from x")).toMatchObject({ ok: true })
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
})

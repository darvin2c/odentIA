import { ADMINISTRATION_ROUTES } from "@odentia/clinical"
import { seedCatalog } from "@odentia/db/products"
import { adminStaff } from "@odentia/db/schema/admin-core"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import { user } from "@odentia/db/schema/auth"
import { branch } from "@odentia/db/schema/org"
import { eq, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { getAgentOverview } from "./agent-overview.js"
import { seedDiagnosisCodes } from "./clinical-test-fixture.js"
import { advanceDemo, buildDemo, demoKindOf } from "./demo-build.js"
import type { DemoKindRecipe, DemoWho } from "./demo-recipes.js"
import { collectedNetMany, listTickets } from "./finance.js"
import { getTimeline } from "./patient-history.js"
import { listConnectionsOverview } from "./connections.js"
import { getConversationDetail } from "./conversations.js"
import { agentConversationsMany } from "./report-agent.js"
import { currentMonthIn, monthStart, reportDayOf } from "./report-periods.js"
import { createSaasPlan } from "./saas-billing.js"
import { requestDemo } from "./saas-demos.js"
import { librarySpecialtyIds } from "./specialties.js"
import { ownerDb, setupTestDb } from "./test-setup.js"

/**
 * La demo cuenta una clínica coherente (QA del 2026-11-04, Z1–Z11): lo que
 * dice una pantalla lo confirma otra. Se arman dos demos, una de cada
 * producto, y se comprueba que cuadran consigo mismas: lo cobrado en Reportes
 * es lo de Cobros y la Caja, cada servicio lo da quien atiende su
 * especialidad a quien le corresponde, los signos vitales cambian como puede
 * cambiar un cuerpo, Sofi dice solo lo que hay y lo que hizo cuenta igual en
 * Agente y en Reportes, y su WhatsApp no dice que envía.
 */
setupTestDb()
const admin = { userId: "coherencia-admin", role: "admin" as const }
const DAY = 86_400_000
/** El rango de ficción de Ofcom: ningún teléfono de la demo es de una persona real. */
const FICTION_PHONE = /^\+447700900\d{3}$/

beforeAll(async () => {
  await ownerDb
    .insert(user)
    .values({ id: admin.userId, name: "Ana Administración", email: "coherencia@example.com" })
  await ownerDb.insert(adminStaff).values({ userId: admin.userId, role: "admin" })
  await seedCatalog(ownerDb)
  // Los diagnósticos de las recetas de las dos demos, como los carga producción (la CIE-11 oficial).
  await seedDiagnosisCodes(
    [
      "CA00",
      "CA02.Z",
      "CA03.Z",
      "1A40.Z",
      "AB00",
      "CA41.0",
      "5B5K.0",
      "QA00.Z",
      "QA00.0",
      "ME84.2Z",
      "8A81.Z",
      "BA00.Z",
      "5A11",
      "5C80.0Z",
      "5B81.01",
      "QA21.0",
      "GA02.Z",
      "GA30.0Z",
      "QA42.Z",
      "DA08.0",
      "DA09.0",
      "DA0A.1",
      "DA0B.1",
      "DA0E.3",
      "QA00.8",
      // Los de la óptica de vistIA.
      "9D00.0",
      "9D00.1",
      "9D00.2",
      "9D00.3",
      "9D00.4",
      "9A79",
      "9D50",
      "9A60.02",
      "9B10.0Z",
      "9C60",
      "9A77.0",
      "9C83.2",
      "9C80.4",
      "QA00.62",
      "QA00.6Z",
    ].map((code) => ({ code, title: code })),
    "ICD-11",
  )
  for (const product of ["dental", "medical", "optical"] as const) {
    await createSaasPlan(ownerDb, admin.userId, {
      code: `coherencia-${product}`,
      name: `Plan ${product}`,
      product,
      currency: "USD",
      priceCents: 2900,
      creditCents: 2900,
      conversationMicros: 500_000,
      consultationMicros: 400_000,
      recoveryMicros: 4_000_000,
      trialCreditCents: 10_000,
      trialMaxCreditCents: 10_000,
      trialDays: 30,
      isDefault: true,
      showOnWeb: false,
    })
  }
})

type Built = {
  id: string
  organizationId: string
  historyThrough: string
  product: "dental" | "medical" | "optical"
  kind: DemoKindRecipe
  size: "pequeno" | "mediano" | "grande"
}

/**
 * La semilla de cada demo es fija, para que una prueba que falla se pueda
 * repetir: el nombre del bloque la dice. `DEMO_SEED` prueba con otra.
 */
const seedOf = (fallback: number): number => Number(process.env.DEMO_SEED ?? fallback)

async function build(input: {
  product: "dental" | "medical" | "optical"
  kind: string
  size: "pequeno" | "mediano" | "grande"
  countryCode: string
  name: string
  seed: number
  months?: 6 | 12
}): Promise<Built> {
  const { seed, months, ...asked0 } = input
  const asked = await requestDemo(ownerDb, admin, {
    ...asked0,
    months: months ?? 6,
    presenterUserId: admin.userId,
  })
  await ownerDb.update(saasDemo).set({ seed }).where(eq(saasDemo.id, asked.id))
  const [row] = await ownerDb.select().from(saasDemo).where(eq(saasDemo.id, asked.id))
  if (!row) throw new Error("falta la demo")
  const ref = { ...row, product: input.product, size: input.size }
  const built = await ownerDb.transaction((tx) =>
    buildDemo(tx, ref, { secretsKey: Buffer.alloc(32, 3), fetch }),
  )
  await ownerDb
    .update(saasDemo)
    .set({
      organizationId: built.organizationId,
      status: "lista",
      historyThrough: built.historyThrough,
      readyAt: new Date(),
    })
    .where(eq(saasDemo.id, asked.id))
  return {
    id: asked.id,
    organizationId: built.organizationId,
    historyThrough: built.historyThrough,
    product: input.product,
    kind: demoKindOf(input.product, input.kind),
    size: input.size,
  }
}

const rows = async <T>(query: ReturnType<typeof sql>): Promise<T[]> =>
  (await ownerDb.execute(query)) as unknown as T[]
const count = async (query: ReturnType<typeof sql>): Promise<number> =>
  Number((await rows<{ n: number }>(query))[0]?.n ?? 0)

/**
 * Un texto de la receta como patrón: lo que la demo llena con sus datos
 * (`{especialidades}`, `{la doctora}`) puede decir cualquier cosa de su tipo.
 */
function said(text: string): RegExp {
  const escaped = text.replace(/[.*+?^$()|[\]\\]/g, "\\$&")
  return new RegExp(
    `^${escaped
      .replaceAll("{especialidades}", "[^{}]+")
      .replaceAll("{la doctora}", "(la doctora|el doctor|el médico)")
      .replaceAll("{La doctora}", "(La doctora|El doctor|El médico)")}$`,
  )
}

/** Años cumplidos el día de la cita (cuenta propia, no la de la semilla). */
function yearsOn(birthDate: string, at: Date): number {
  const [year, month, day] = birthDate.split("-").map(Number) as [number, number, number]
  const local = at.toISOString().slice(0, 10).split("-").map(Number) as [number, number, number]
  return local[0] - year - (local[1] < month || (local[1] === month && local[2] < day) ? 1 : 0)
}

function outside(who: DemoWho | undefined, age: number, sex: string | null): boolean {
  if (!who) return false
  if (who.sex && sex !== who.sex) return true
  if (who.minAge !== undefined && age < who.minAge) return true
  if (who.maxAge !== undefined && age > who.maxAge) return true
  return false
}

/** Lo que vale para las dos demos: cifras, citas, atenciones, Sofi y WhatsApp. */
function coherent(demo: () => Built) {
  it("lo cobrado en Reportes es lo de Finanzas › Cobros, y cada cobro está en la caja de su día (Z5)", async () => {
    const { organizationId: orgId } = demo()
    expect(
      await count(
        sql`select count(*)::int as n from patient_payment where organization_id = ${orgId} and voided_at is null and ticket_id is null`,
      ),
    ).toBe(0)
    expect(
      await count(
        sql`select count(*)::int as n from patient_payment_application where organization_id = ${orgId} and voided_at is null and ticket_id is null`,
      ),
    ).toBe(0)
    // Este mes, sede por sede: lo que suma Reportes y lo que lista Cobros.
    const [profile] = await rows<{ timezone: string }>(
      sql`select timezone from org_profile where organization_id = ${orgId}`,
    )
    const timezone = profile?.timezone ?? "America/Lima"
    const month = currentMonthIn(timezone)
    const now = new Date()
    const from = `${month.year}-${String(month.month).padStart(2, "0")}-01`
    const branches = await ownerDb
      .select({ id: branch.id })
      .from(branch)
      .where(eq(branch.organizationId, orgId))
    for (const item of branches) {
      const [collected] = await collectedNetMany(
        ownerDb,
        orgId,
        [{ start: monthStart(timezone, month.year, month.month), end: now }],
        {
          branchId: item.id,
        },
      )
      const reported = (collected ?? []).reduce((sum, part) => sum + part.cents, 0)
      const tickets = await listTickets(ownerDb, orgId, {
        branchId: item.id,
        from,
        to: reportDayOf(timezone, now),
      })
      const listed = (tickets.totals ?? []).reduce((sum, part) => sum + part.cobradoCents, 0)
      expect({ branch: item.id, cents: listed }).toEqual({ branch: item.id, cents: reported })
    }
    // Cada cobro entró una vez en la caja, y cada cierre cuenta el efectivo que entró en su caja.
    expect(
      await count(sql`select count(*)::int as n from patient_payment p where p.organization_id = ${orgId} and p.voided_at is null
        and (select count(*) from cash_movement m where m.organization_id = p.organization_id and m.patient_payment_id = p.id and m.kind = 'cobro' and m.voided_at is null) <> 1`),
    ).toBe(0)
    expect(
      await count(
        sql`select count(*)::int as n from cash_closure where organization_id = ${orgId}`,
      ),
    ).toBeGreaterThan(20)
    expect(
      await count(sql`select count(*)::int as n from cash_closure k where k.organization_id = ${orgId}
        and k.cash_collected_cents <> (select coalesce(sum(m.amount_cents), 0) from cash_movement m
          where m.organization_id = k.organization_id and m.shift_id = k.shift_id and m.kind = 'cobro' and m.method_type_code = '10' and m.voided_at is null)`),
    ).toBe(0)
    // Ningún día anterior queda con la caja abierta.
    expect(
      await count(sql`select count(*)::int as n from cash_shift where organization_id = ${orgId} and status = 'abierta'
        and opened_at < now() - interval '1 day'`),
    ).toBe(0)
  })

  it("cada servicio lo da quien atiende su especialidad, a quien le toca por edad y sexo, y nadie viene antes de nacer (Z6)", async () => {
    const { organizationId: orgId, kind } = demo()
    const kinds = [
      ...new Set([
        ...(kind.specialtyRotation ?? []),
        ...(kind.professional.specialty ? [kind.professional.specialty] : []),
      ]),
    ]
    const kindOfId = new Map(
      [...(await librarySpecialtyIds(ownerDb, orgId, kinds))].map(([key, id]) => [id, key]),
    )
    const visits = await rows<{
      template: string
      starts_at: string
      birth_date: string | null
      sex: string | null
      specialty_id: string | null
      pro: string[] | null
      attended_by_someone: boolean
    }>(sql`
      select t.key as template, a.starts_at::text as starts_at, c.birth_date::text as birth_date, c.sex, sc.specialty_id,
        (select array_agg(ps.specialty_id::text) from professional_specialty ps
          where ps.organization_id = a.organization_id and ps.user_id = a.professional_user_id) as pro,
        exists (select 1 from professional_specialty ps where ps.organization_id = a.organization_id and ps.specialty_id = sc.specialty_id) as attended_by_someone
      from appointment a
      join service_catalog sc on sc.organization_id = a.organization_id and sc.id = a.service_id
      join treatment_template t on t.id = sc.template_id
      join patient p on p.organization_id = a.organization_id and p.id = a.patient_id
      join contact c on c.organization_id = p.organization_id and c.id = p.person_id
      where a.organization_id = ${orgId}`)
    expect(visits.length).toBeGreaterThan(100)
    const recipeOf = new Map(kind.services.map((item) => [item.template, item]))
    const wrong: string[] = []
    for (const visit of visits) {
      const at = new Date(visit.starts_at)
      const recipe = recipeOf.get(visit.template)
      const proKinds = (visit.pro ?? [])
        .map((id) => kindOfId.get(id))
        .filter((key): key is string => Boolean(key))
      // La regla de la agenda de la app: un servicio con especialidad lo da quien la tiene.
      if (
        visit.specialty_id &&
        visit.attended_by_someone &&
        !(visit.pro ?? []).includes(visit.specialty_id)
      )
        wrong.push(`${visit.template} con quien no tiene su especialidad`)
      if (recipe?.specialty && !proKinds.includes(recipe.specialty))
        wrong.push(`${visit.template} con ${proKinds.join(",") || "nadie"}`)
      if (!visit.birth_date) continue
      if (visit.birth_date > visit.starts_at.slice(0, 10))
        wrong.push(`${visit.template} antes de nacer`)
      const age = yearsOn(visit.birth_date, at)
      if (outside(recipe?.who, age, visit.sex))
        wrong.push(`${visit.template} a ${visit.sex} de ${age} años`)
      for (const proKind of proKinds)
        if (outside(kind.specialtyWho?.[proKind], age, visit.sex))
          wrong.push(`${proKind} a ${visit.sex} de ${age} años`)
    }
    expect(wrong.slice(0, 10)).toEqual([])
  })

  it("una consulta se cobra una vez: solo lo que va por unidad sale de a dos o tres (Z8)", async () => {
    const { organizationId: orgId, kind } = demo()
    const perUnit = kind.services.filter((item) => item.perUnit).map((item) => item.template)
    const many = await rows<{ template: string }>(sql`
      select t.key as template from encounter_procedure ep
      join service_catalog sc on sc.organization_id = ep.organization_id and sc.id = ep.service_id
      join treatment_template t on t.id = sc.template_id
      where ep.organization_id = ${orgId} and ep.quantity > 1`)
    expect(many.filter((row) => !perUnit.includes(row.template))).toEqual([])
  })

  it("las atenciones se fechan el día que empezaron, también en la Historia (Z2)", async () => {
    const { organizationId: orgId } = demo()
    expect(
      await count(
        sql`select count(*)::int as n from encounter where organization_id = ${orgId} and status = 'finalizada' and created_at <> started_at`,
      ),
    ).toBe(0)
    const [someone] = await rows<{ patient_id: string }>(sql`
      select patient_id from encounter where organization_id = ${orgId} and status = 'finalizada'
      group by patient_id order by count(*) desc limit 1`)
    if (!someone) throw new Error("faltan atenciones")
    const timeline = await getTimeline(ownerDb, orgId, someone.patient_id, {
      types: ["encounter"],
      limit: 100,
    })
    const started = new Map(
      (
        await rows<{ id: string; started_at: string }>(sql`
          select id, started_at::text as started_at from encounter where organization_id = ${orgId} and patient_id = ${someone.patient_id}`)
      ).map((row) => [row.id, new Date(row.started_at).getTime()]),
    )
    expect(timeline.data.length).toBeGreaterThan(1)
    for (const item of timeline.data)
      expect(new Date(item.createdAt).getTime()).toBe(started.get(item.id))
  })

  it("quien escribe por WhatsApp tiene su número (de ficción) y la cita que viene es de alguien a quien se le puede confirmar (Z1)", async () => {
    const { organizationId: orgId } = demo()
    const phones = await rows<{ phone: string }>(
      sql`select phone from contact where organization_id = ${orgId} and phone is not null`,
    )
    expect(phones.length).toBeGreaterThan(50)
    expect(phones.filter((row) => !FICTION_PHONE.test(row.phone))).toEqual([])
    // Quien escribió en el último mes tiene su número y su identidad de WhatsApp, y su conversación lo dice.
    expect(
      await count(sql`select count(distinct c.contact_id)::int as n from conversation c
        join contact k on k.organization_id = c.organization_id and k.id = c.contact_id
        where c.organization_id = ${orgId} and c.last_message_at > now() - interval '30 days'
          and (k.phone is null or not exists (select 1 from contact_identity i where i.organization_id = c.organization_id and i.contact_id = c.contact_id and i.channel = 'whatsapp'))`),
    ).toBe(0)
    expect(
      await count(sql`select count(*)::int as n from conversation c
        join channel_connection cc on cc.organization_id = c.organization_id and cc.id = c.channel_connection_id and cc.channel = 'whatsapp'
        where c.organization_id = ${orgId} and c.contact_identity_id is null
          and exists (select 1 from contact_identity i where i.organization_id = c.organization_id and i.contact_id = c.contact_id and i.channel = 'whatsapp')`),
    ).toBe(0)
    expect(
      await count(sql`select count(*)::int as n from appointment a
        join patient p on p.organization_id = a.organization_id and p.id = a.patient_id
        join contact k on k.organization_id = p.organization_id and k.id = p.person_id
        where a.organization_id = ${orgId} and a.starts_at > now() and a.status in ('programada', 'confirmada')
          and k.phone is null and not exists (
            select 1 from patient_contact g join contact gk on gk.organization_id = g.organization_id and gk.id = g.contact_id
            where g.organization_id = a.organization_id and g.patient_id = p.id and g.relationship = 'guardian' and gk.phone is not null)`),
    ).toBe(0)
  })

  it("su WhatsApp no dice que envía: queda desconectado, sin la calidad ni el límite que Meta nunca dio (Z4)", async () => {
    const { organizationId: orgId } = demo()
    const connections = await rows<{
      status: string
      health: unknown
      webhook_verified_at: string | null
    }>(sql`
      select status, health, webhook_verified_at from channel_connection where organization_id = ${orgId} and channel = 'whatsapp'`)
    expect(connections).toEqual([{ status: "disabled", health: null, webhook_verified_at: null }])
    // Integraciones, la Bandeja y Agente dicen que es la conexión de la demo, que no envía ni recibe de verdad.
    const [listed] = await listConnectionsOverview(ownerDb, orgId)
    expect(listed).toMatchObject({ status: "disabled", demoClinic: true })
    const [anyone] = await rows<{ id: string }>(
      sql`select id from conversation where organization_id = ${orgId} limit 1`,
    )
    if (!anyone) throw new Error("faltan conversaciones")
    const detail = await getConversationDetail(ownerDb, orgId, anyone.id)
    expect(detail.connection).toMatchObject({ status: "disabled", demoClinic: true })
    const overview = await getAgentOverview(ownerDb, orgId)
    expect(overview.readiness).toMatchObject({ channels: [], demoClinic: true })
    // Sofi no dice que responde por WhatsApp.
    const [about] = await rows<{ about: string | null }>(
      sql`select about from agent_config where organization_id = ${orgId}`,
    )
    expect(about?.about ?? "").not.toMatch(/whatsapp/i)
  })

  it("Sofi dice solo lo que hay: cada respuesta contesta su pregunta y nada habla de una sede que no existe (Z7)", async () => {
    const { organizationId: orgId, kind } = demo()
    const branches = await count(
      sql`select count(*)::int as n from branch where organization_id = ${orgId}`,
    )
    const written = await rows<{ body: string }>(sql`
      select body from message where organization_id = ${orgId} and body is not null
        and (sender_kind = 'agent' or direction = 'in')`)
    if (branches === 1) expect(written.filter((row) => /sede/i.test(row.body))).toEqual([])
    // Cada respuesta de Sofi contesta lo último que le escribieron antes (también en una conversación reabierta).
    const pairs = await rows<{ asked: string; answered: string }>(sql`
      select (select i.body from message i where i.organization_id = m.organization_id and i.conversation_id = m.conversation_id
          and i.direction = 'in' and i.created_at <= m.created_at order by i.created_at desc limit 1) as asked,
        m.body as answered
      from message m where m.organization_id = ${orgId} and m.sender_kind = 'agent'`)
    const answered = pairs.filter((row) => row.answered && row.asked)
    expect(answered.length).toBeGreaterThan(20)
    for (const row of answered) {
      const index = kind.inbound.findIndex((text) => said(text).test(row.asked))
      expect({ asked: row.asked, index: index >= 0 }).toEqual({ asked: row.asked, index: true })
      expect(row.answered).toMatch(said(kind.reply[index] as string))
    }
  })

  it("lo que hizo Sofi esta semana cuenta igual en Agente y en Reportes (Z11)", async () => {
    const { organizationId: orgId } = demo()
    // Agente cuenta conversaciones con corridas; Reportes, con respuestas de Sofi: cada
    // corrida tiene su respuesta cerca y cada respuesta su corrida.
    expect(
      await rows(sql`
        select l.conversation_id from agent_run_ledger l
        where l.organization_id = ${orgId} and l.status in ('ok', 'handoff')
          and not exists (select 1 from message m where m.organization_id = l.organization_id and m.conversation_id = l.conversation_id
            and m.sender_kind = 'agent' and m.status in ('sent', 'delivered', 'read')
            and m.created_at between l.started_at - interval '10 minutes' and l.started_at + interval '10 minutes')
        union all
        select m.conversation_id from message m
        where m.organization_id = ${orgId} and m.sender_kind = 'agent' and m.status in ('sent', 'delivered', 'read')
          and not exists (select 1 from agent_run_ledger l where l.organization_id = m.organization_id and l.conversation_id = m.conversation_id
            and l.started_at between m.created_at - interval '10 minutes' and m.created_at + interval '10 minutes')`),
    ).toEqual([])
    const now = new Date()
    const since = new Date(now.getTime() - 7 * DAY)
    const overview = await getAgentOverview(ownerDb, orgId)
    const [reports] = await agentConversationsMany(ownerDb, orgId, [{ start: since, end: now }])
    expect(overview.week.attended).toBeGreaterThan(0)
    // Solo puede diferir lo que cae justo en el borde de la semana (una respuesta y su corrida a cada lado).
    const edge = await count(sql`
      select count(distinct conversation_id)::int as n from (
        select conversation_id from agent_run_ledger where organization_id = ${orgId}
          and started_at between ${since.toISOString()}::timestamptz - interval '10 minutes' and ${since.toISOString()}::timestamptz + interval '10 minutes'
        union all
        select conversation_id from message where organization_id = ${orgId} and sender_kind = 'agent'
          and created_at between ${since.toISOString()}::timestamptz - interval '10 minutes' and ${since.toISOString()}::timestamptz + interval '10 minutes'
      ) x`)
    expect(Math.abs(overview.week.attended - (reports?.attended ?? 0))).toBeLessThanOrEqual(edge)
  })

  it("los controles son los de su receta: su nombre, y solo a quien lo necesita (Z9)", async () => {
    const { organizationId: orgId, kind } = demo()
    const titles = await rows<{ title: string; n: number }>(sql`
      select title, count(*)::int as n from clinical_follow_up where organization_id = ${orgId} group by title`)
    if (!kind.followUp) {
      expect(titles).toEqual([])
      return
    }
    expect(titles.map((row) => row.title)).toEqual([kind.followUp.title])
    const diagnoses = kind.followUp.diagnoses ?? []
    if (diagnoses.length > 0)
      expect(
        await count(sql`select count(*)::int as n from clinical_follow_up f where f.organization_id = ${orgId}
          and not exists (select 1 from encounter_diagnosis d where d.organization_id = f.organization_id and d.encounter_id = f.origin_encounter_id
            and d.diagnosis_code in (${sql.join(
              diagnoses.map((code) => sql`${code}`),
              sql`, `,
            )}))`),
      ).toBe(0)
  })

  it("ponerla al día no deja un cobro sin su ticket ni su caja", async () => {
    const built = demo()
    const [row] = await ownerDb.select().from(saasDemo).where(eq(saasDemo.id, built.id))
    if (!row) throw new Error("falta la demo")
    await ownerDb.transaction((tx) =>
      advanceDemo(tx, {
        ...row,
        product: built.product,
        size: built.size,
        organizationId: built.organizationId,
      }),
    )
    expect(
      await count(sql`select count(*)::int as n from patient_payment p where p.organization_id = ${built.organizationId} and p.voided_at is null
        and (p.ticket_id is null or not exists (select 1 from cash_movement m where m.organization_id = p.organization_id and m.patient_payment_id = p.id and m.kind = 'cobro'))`),
    ).toBe(0)
  })
}

/** Lo que vale para las demos de latidIA: el cuerpo de cada persona, su enfermedad crónica y lo que se escribe a su edad. */
function medical(demo: () => Built) {
  it("los signos vitales cambian como puede cambiar un cuerpo entre una medición y otra (Z10)", async () => {
    const measured = await rows<{
      patient_id: string
      started_at: string
      talla: string | null
      peso: string | null
    }>(sql`
      select patient_id, started_at::text as started_at, vitals->>'talla' as talla, vitals->>'peso' as peso
      from encounter where organization_id = ${demo().organizationId} and status = 'finalizada' and vitals is not null
      order by patient_id, started_at`)
    expect(measured.length).toBeGreaterThan(100)
    const wrong: string[] = []
    for (let index = 1; index < measured.length; index += 1) {
      const before = measured[index - 1] as (typeof measured)[number]
      const after = measured[index] as (typeof measured)[number]
      if (before.patient_id !== after.patient_id) continue
      const years =
        (new Date(after.started_at).getTime() - new Date(before.started_at).getTime()) /
        (365.25 * DAY)
      const talla = Number(after.talla) - Number(before.talla)
      const peso = Number(after.peso) - Number(before.peso)
      // Nadie se encoge; un niño crece a lo más unos 30 cm al año; el peso cambia poco en días.
      if (talla < -1 || talla > 1 + 30 * years)
        wrong.push(`talla ${before.talla} → ${after.talla} en ${Math.round(years * 365)} días`)
      if (Math.abs(peso) > 1.5 + Math.max(Number(after.peso), Number(before.peso)) * years)
        wrong.push(`peso ${before.peso} → ${after.peso} en ${Math.round(years * 365)} días`)
    }
    expect(wrong.slice(0, 10)).toEqual([])
  })

  it("cada persona tiene una sola enfermedad crónica, la misma con cualquier médico", async () => {
    const mixed = await rows<{ patient_id: string; codes: string[] }>(sql`
      select patient_id, array_agg(distinct diagnosis_code) as codes from encounter_diagnosis
      where organization_id = ${demo().organizationId} and diagnosis_code in ('BA00.Z', '5A11', '5C80.0Z', '5B81.01')
      group by patient_id having count(distinct diagnosis_code) > 1`)
    expect(mixed.slice(0, 5)).toEqual([])
  })

  it("lo que se escribe va con la edad: bronquiolitis antes de los 2 años, bochornos desde los 45, anticoncepción de 15 a 49", async () => {
    const wrong = await rows<{ code: string; age: number }>(sql`
      select d.diagnosis_code as code, extract(year from age(e.started_at::date, c.birth_date))::int as age
      from encounter_diagnosis d
      join encounter e on e.organization_id = d.organization_id and e.id = d.encounter_id
      join patient p on p.organization_id = e.organization_id and p.id = e.patient_id
      join contact c on c.organization_id = p.organization_id and c.id = p.person_id
      where d.organization_id = ${demo().organizationId} and (
        (d.diagnosis_code = 'CA41.0' and age(e.started_at::date, c.birth_date) >= interval '2 years')
        or (d.diagnosis_code = 'GA30.0Z' and age(e.started_at::date, c.birth_date) < interval '45 years')
        or (d.diagnosis_code = 'QA21.0' and (age(e.started_at::date, c.birth_date) < interval '15 years' or age(e.started_at::date, c.birth_date) >= interval '50 years'))
      ) limit 5`)
    expect(wrong).toEqual([])
  })
}

/** Las recetas y los descansos de latidIA (Z3), en una demo con consultas generales. */
function papers(demo: () => Built) {
  it("tiene recetas y descansos médicos para imprimir, firmados y numerados (Z3)", async () => {
    const orgId = demo().organizationId
    expect(
      await count(
        sql`select count(*)::int as n from prescription where organization_id = ${orgId}`,
      ),
    ).toBeGreaterThan(20)
    expect(
      await count(
        sql`select count(*)::int as n from medical_leave where organization_id = ${orgId}`,
      ),
    ).toBeGreaterThan(5)
    // Con quien prescribe, con medicamentos de vía conocida.
    expect(
      await count(
        sql`select count(*)::int as n from prescription where organization_id = ${orgId} and (prescriber_name is null or prescriber_name = '')`,
      ),
    ).toBe(0)
    const routes = await rows<{ route: string }>(
      sql`select distinct route from prescription_item where organization_id = ${orgId}`,
    )
    for (const row of routes)
      expect(ADMINISTRATION_ROUTES as readonly string[]).toContain(row.route)
    // La receta de un menor de 12 años lleva su peso; el descanso es de un adulto.
    expect(
      await count(sql`select count(*)::int as n from prescription r
        join patient p on p.organization_id = r.organization_id and p.id = r.patient_id
        join contact c on c.organization_id = p.organization_id and c.id = p.person_id
        where r.organization_id = ${orgId} and age(r.issued_at::date, c.birth_date) < interval '12 years' and r.patient_weight_kg is null`),
    ).toBe(0)
    expect(
      await count(sql`select count(*)::int as n from medical_leave l
        join patient p on p.organization_id = l.organization_id and p.id = l.patient_id
        join contact c on c.organization_id = p.organization_id and c.id = p.person_id
        where l.organization_id = ${orgId} and age(l.starts_on, c.birth_date) < interval '18 years'`),
    ).toBe(0)
  })
}

const POLICLINICO_MEDIANO = seedOf(20_261_104)
describe(`una demo de Policlínico mediana (latidIA, semilla ${POLICLINICO_MEDIANO})`, () => {
  let demo: Built
  beforeAll(async () => {
    demo = await build({
      product: "medical",
      kind: "policlinico",
      size: "mediano",
      countryCode: "PE",
      name: "Policlínico Coherente",
      seed: POLICLINICO_MEDIANO,
    })
  }, 300_000)

  coherent(() => demo)
  medical(() => demo)
  papers(() => demo)

  it("ofrece y dice solo las especialidades de su equipo (Z6, Z7)", async () => {
    const orgId = demo.organizationId
    const attended = await rows<{ name: string }>(sql`
      select distinct s.name from professional_specialty ps join org_specialty s on s.organization_id = ps.organization_id and s.id = ps.specialty_id
      where ps.organization_id = ${orgId}`)
    // Las tres del tamaño mediano: medicina general, pediatría y ginecología.
    expect(attended.length).toBe(3)
    const offered = await rows<{ key: string }>(sql`
      select t.key from service_catalog sc join treatment_template t on t.id = sc.template_id where sc.organization_id = ${orgId}`)
    expect(offered.map((row) => row.key)).not.toContain("consulta-medicina-interna")
    expect(offered.map((row) => row.key)).not.toContain("consulta-medicina-familiar")
    const listed = await rows<{ body: string }>(sql`
      select body from message where organization_id = ${orgId} and sender_kind = 'agent' and body like 'Atendemos %'`)
    expect(listed.length).toBeGreaterThan(0)
    for (const row of listed) {
      for (const item of attended) expect(row.body).toContain(item.name.toLocaleLowerCase("es"))
      expect(row.body).not.toMatch(/interna|familiar|\{/)
    }
  })
})

// Con 8 profesionales entra medicina interna: la misma persona la ve el internista y el médico general.
const POLICLINICO_GRANDE = seedOf(20_261_105)
describe(`una demo de Policlínico grande (latidIA, semilla ${POLICLINICO_GRANDE})`, () => {
  let demo: Built
  beforeAll(async () => {
    demo = await build({
      product: "medical",
      kind: "policlinico",
      size: "grande",
      countryCode: "PE",
      name: "Policlínico Grande Coherente",
      seed: POLICLINICO_GRANDE,
    })
  }, 600_000)

  coherent(() => demo)
  medical(() => demo)
  papers(() => demo)

  it("tiene medicina interna, y sus controles de presión y glucosa son de quien tiene hipertensión o diabetes", async () => {
    const orgId = demo.organizationId
    expect(
      await count(sql`select count(*)::int as n from appointment a
        join service_catalog sc on sc.organization_id = a.organization_id and sc.id = a.service_id
        join treatment_template t on t.id = sc.template_id
        where a.organization_id = ${orgId} and t.key = 'consulta-medicina-interna'`),
    ).toBeGreaterThan(0)
    expect(
      await count(
        sql`select count(*)::int as n from clinical_follow_up where organization_id = ${orgId}`,
      ),
    ).toBeGreaterThan(0)
  })
})

const GINECOLOGIA = seedOf(20_261_106)
describe(`una demo de ginecología pequeña (latidIA, semilla ${GINECOLOGIA})`, () => {
  let demo: Built
  beforeAll(async () => {
    demo = await build({
      product: "medical",
      kind: "ginecologia_obstetricia",
      size: "pequeno",
      countryCode: "PE",
      name: "Ginecología Coherente",
      seed: GINECOLOGIA,
      // Con un año de historia hay gestaciones que ya terminaron.
      months: 12,
    })
  }, 300_000)

  coherent(() => demo)
  medical(() => demo)

  it("el control prenatal es de la gestación de ahora: el que pasa de nueve meses ya no queda pendiente", async () => {
    const orgId = demo.organizationId
    expect(
      await count(sql`select count(*)::int as n from clinical_follow_up f
        join encounter e on e.organization_id = f.organization_id and e.id = f.origin_encounter_id
        where f.organization_id = ${orgId} and f.status = 'pendiente' and e.ended_at < now() - interval '9 months'`),
    ).toBe(0)
    expect(
      await count(sql`select count(*)::int as n from clinical_follow_up
        where organization_id = ${orgId} and status = 'cancelado' and cancelled_reason = 'Terminó la gestación'`),
    ).toBeGreaterThan(0)
  })
})

const OPTICA = seedOf(20_261_108)
describe(`una demo de óptica pequeña (vistIA, semilla ${OPTICA})`, () => {
  let demo: Built
  beforeAll(async () => {
    demo = await build({
      product: "optical",
      kind: "optica",
      size: "pequeno",
      countryCode: "PE",
      name: "Óptica Coherente",
      seed: OPTICA,
      months: 6,
    })
  }, 300_000)

  coherent(() => demo)

  it("Clío no dicta en una óptica: ni encendido ni consultas dictadas en su historia", async () => {
    const orgId = demo.organizationId
    expect(
      await count(
        sql`select count(*)::int as n from agent_config where organization_id = ${orgId} and clinical_assistant_enabled`,
      ),
    ).toBe(0)
    expect(
      await count(sql`select count(*)::int as n from saas_action where organization_id = ${orgId} and kind = 'consulta'`),
    ).toBe(0)
  })

  it("los optómetras se presentan como licenciados, no como doctores", async () => {
    const orgId = demo.organizationId
    const names = (await ownerDb.execute(sql`select u.name from member m join auth."user" u on u.id = m.user_id
      where m.organization_id = ${orgId} and m.role = 'clinician'`)) as unknown as Array<{ name: string }>
    expect(names.length).toBeGreaterThan(0)
    expect(names.every((row) => row.name.startsWith("Lic. "))).toBe(true)
  })

  it("la óptica atiende con su biblioteca y cuenta su examen anual", async () => {
    const orgId = demo.organizationId
    expect(
      await count(sql`select count(*)::int as n from service_catalog s join catalog.treatment_template t on t.id = s.template_id
        where s.organization_id = ${orgId} and t.product <> 'optical'`),
    ).toBe(0)
    expect(
      await count(sql`select count(*)::int as n from encounter where organization_id = ${orgId} and status = 'finalizada'`),
    ).toBeGreaterThan(0)
  })
})

const DENTAL = seedOf(20_261_107)
/** Noches que se recorren seguidas: más de las 4 semanas en que antes la Bandeja de hoy se vaciaba. */
const NIGHTS = 32
describe(`una demo de clínica general pequeña (odentIA, semilla ${DENTAL})`, () => {
  let demo: Built
  beforeAll(async () => {
    demo = await build({
      product: "dental",
      kind: "general",
      size: "pequeno",
      countryCode: "MX",
      name: "Dental Coherente",
      seed: DENTAL,
    })
  }, 300_000)

  coherent(() => demo)

  it("lo que se cobra por pieza a veces va de a dos o tres", async () => {
    expect(
      await count(
        sql`select count(*)::int as n from encounter_procedure where organization_id = ${demo.organizationId} and quantity > 1`,
      ),
    ).toBeGreaterThan(0)
  })

  // QA del 6 nov (D5): la visita que hacía lo aceptado no lo llevaba y el plan decía
  // «0 de 1 sesión · sin cargos» con su ticket en Cobros.
  it("la visita que hace lo aceptado lleva su tratamiento, también en su cargo", async () => {
    expect(
      await count(
        sql`select count(*)::int as n from encounter_procedure where organization_id = ${demo.organizationId} and plan_item_id is not null`,
      ),
    ).toBeGreaterThan(0)
    // Ningún procedimiento lleva un tratamiento de otro servicio o de otra persona, ni uno sin aceptar.
    expect(
      await count(sql`select count(*)::int as n from encounter_procedure ep
        join encounter e on e.organization_id = ep.organization_id and e.id = ep.encounter_id
        join treatment_plan_item pi on pi.organization_id = ep.organization_id and pi.id = ep.plan_item_id
        where ep.organization_id = ${demo.organizationId}
          and (pi.service_id <> ep.service_id or pi.patient_id <> e.patient_id or pi.decision_status <> 'aceptado')`),
    ).toBe(0)
    // Lo aceptado hace más de dos meses casi todo se hizo: una demo de ventas no muestra
    // abandono masivo (revisión del 7 nov). Se deja una minoría, cerca de uno de cada ocho.
    const [old] = await ownerDb.execute<{ total: number; done: number }>(sql`
      select count(*)::int as total,
        count(*) filter (where exists (select 1 from encounter_procedure ep
          where ep.organization_id = pi.organization_id and ep.plan_item_id = pi.id and ep.voided_at is null))::int as done
      from treatment_plan_item pi
      join treatment_budget b on b.organization_id = pi.organization_id and b.id = pi.budget_id
      where pi.organization_id = ${demo.organizationId} and pi.decision_status = 'aceptado'
        and b.decided_at < now() - interval '64 days'`)
    expect(old?.total ?? 0).toBeGreaterThan(0)
    expect((old?.done ?? 0) / (old?.total ?? 1)).toBeGreaterThanOrEqual(0.8)
    // Su cargo dice de qué tratamiento es.
    expect(
      await count(sql`select count(*)::int as n from patient_charge c
        join encounter_procedure ep on ep.organization_id = c.organization_id and ep.id = c.encounter_procedure_id
        where c.organization_id = ${demo.organizationId} and ep.plan_item_id is not null and c.plan_item_id is distinct from ep.plan_item_id`),
    ).toBe(0)
  })

  it(`noche tras noche, ${NIGHTS} seguidas, la Bandeja de hoy se llena y quien vuelve a escribir vuelve a su conversación`, async () => {
    const [row] = await ownerDb.select().from(saasDemo).where(eq(saasDemo.id, demo.id))
    if (!row) throw new Error("falta la demo")
    let historyThrough = row.historyThrough
    const start = Date.now()
    const perNight: number[] = []
    let reopened = 0
    for (let night = 1; night <= NIGHTS; night += 1) {
      const at = new Date(start + night * DAY)
      const done = await ownerDb.transaction((tx) =>
        advanceDemo(
          tx,
          {
            ...row,
            product: demo.product,
            size: demo.size,
            organizationId: demo.organizationId,
            historyThrough,
          },
          at,
        ),
      )
      historyThrough = done.historyThrough
      const today = await rows<{ id: string; phone: string | null; before: boolean }>(sql`
        select c.id, k.phone,
          exists (select 1 from message o where o.organization_id = c.organization_id and o.conversation_id = c.id
            and (o.external_id is null or o.external_id not like ${`demo-${done.today}-%`})) as before
        from conversation c
        join contact k on k.organization_id = c.organization_id and k.id = c.contact_id
        where c.organization_id = ${demo.organizationId}
          and exists (select 1 from message m where m.organization_id = c.organization_id and m.conversation_id = c.id
            and m.external_id like ${`demo-${done.today}-%-a`})`)
      perNight.push(today.length)
      // Cada una de alguien con su número: nadie «Sin teléfono».
      expect({ night, sinTelefono: today.filter((item) => !item.phone).length }).toEqual({
        night,
        sinTelefono: 0,
      })
      reopened += today.filter((item) => item.before).length
    }
    // Un profesional: 4 + 3 conversaciones cada noche, todas las noches.
    expect(perNight).toEqual(Array.from({ length: NIGHTS }, () => 7))
    // Quien ya había escrito volvió a su conversación, que se reabrió.
    expect(reopened).toBeGreaterThan(NIGHTS)
  }, 600_000)
})

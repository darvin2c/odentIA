process.env.DOCKER_HOST ??= "unix:///mnt/wsl/podman-sockets/odentia.sock"

import { readdir, readFile } from "node:fs/promises"
import { sql } from "drizzle-orm"
import { GenericContainer, Wait } from "testcontainers"
import { expect, it } from "vitest"
import { createOwnerDb } from "./client.js"

/**
 * 0086 (ADR 0028): las oportunidades automáticas se borran con un criterio
 * seguro, la próxima acción pasa a ser una tarea (una sola), las etapas quedan
 * en los cuatro pasos fijos sin perder oportunidades, los cierres anteriores
 * conservan su texto como nota y la línea «Seguimiento sin responsable» se va.
 */
it("lleva las ventas a los cuatro pasos fijos sin perder lo que es de una persona", async () => {
  const container = await new GenericContainer("dentalagent-postgres:18.6")
    .withExposedPorts(5432)
    .withEnvironment({
      POSTGRES_DB: "dentalagent",
      POSTGRES_USER: "dentalagent",
      POSTGRES_PASSWORD: "dentalagent",
      POSTGRES_APP_PASSWORD: "dentalagent_app",
    })
    .withWaitStrategy(Wait.forLogMessage("database system is ready to accept connections", 2))
    .withCommand(["postgres", "-c", "shared_preload_libraries=pg_cron", "-c", "cron.database_name=dentalagent"])
    .start()
  try {
    const db = createOwnerDb(
      `postgres://dentalagent:dentalagent@${container.getHost()}:${container.getMappedPort(5432)}/dentalagent`,
    )
    const files = (await readdir("drizzle")).filter((f) => /^\d{4}_.*\.sql$/.test(f)).sort()
    const apply = async (file: string) => {
      for (const statement of (await readFile(`drizzle/${file}`, "utf8")).split("--> statement-breakpoint")) {
        if (statement.trim()) await db.execute(sql.raw(statement))
      }
    }
    for (const file of files.filter((f) => Number(f.slice(0, 4)) < 86)) await apply(file)
    const q = (text: string) => db.execute(sql.raw(text))
    await q(`insert into organization (id, name, slug, created_at) values ('legacy', 'Legado', 'legacy', now())`)
    await q(`insert into "user" (id, name, email, email_verified) values ('u1', 'Ana', 'ana@legacy.test', true)`)
    await q(`insert into member (id, organization_id, user_id, role, created_at) values ('m1', 'legacy', 'u1', 'reception', now())`)
    await q(`insert into pipeline (id, organization_id, name, is_default) values ('11111111-1111-4111-8111-111111111111', 'legacy', 'Ventas', true)`)
    const stages: Array<[string, string, number, string]> = [
      ["21111111-1111-4111-8111-111111111111", "Nuevo", 0, "open"],
      ["22222222-2222-4222-8222-222222222222", "Contactado", 1, "open"],
      ["23333333-3333-4333-8333-333333333333", "Cita agendada", 2, "open"],
      ["24444444-4444-4444-8444-444444444444", "Ganado", 3, "won"],
      ["25555555-5555-4555-8555-555555555555", "Perdido", 4, "lost"],
    ]
    for (const [id, name, position, kind] of stages) {
      await q(`insert into pipeline_stage (id, organization_id, pipeline_id, name, position, kind)
        values ('${id}', 'legacy', '11111111-1111-4111-8111-111111111111', '${name}', ${position}, '${kind}')`)
    }
    await q(`insert into contact (id, organization_id, display_name) values
      ('31111111-1111-4111-8111-111111111111', 'legacy', 'Hola Solo'),
      ('32222222-2222-4222-8222-222222222222', 'legacy', 'Jorge Ramos')`)
    const opp = (id: string, contact: string, stage: string, title: string, extra = "", values = "") =>
      q(`insert into opportunity (id, organization_id, contact_id, pipeline_id, stage_id, title, currency${extra})
        values ('${id}', 'legacy', '${contact}', '11111111-1111-4111-8111-111111111111', '${stage}', '${title}', 'PEN'${values})`)
    // La automática: «Seguimiento · …» sin ningún dato de un interés concreto.
    await opp("41111111-1111-4111-8111-111111111111", "31111111-1111-4111-8111-111111111111", stages[0][0], "Seguimiento · Hola Solo")
    await q(`insert into crm_note (organization_id, contact_id, opportunity_id, body, author_kind)
      values ('legacy', '31111111-1111-4111-8111-111111111111', '41111111-1111-4111-8111-111111111111', 'Saludó', 'user')`).catch(async () => {
      await q(`insert into crm_note (organization_id, contact_id, opportunity_id, body)
        values ('legacy', '31111111-1111-4111-8111-111111111111', '41111111-1111-4111-8111-111111111111', 'Saludó')`)
    })
    // Con «Seguimiento ·» pero con un valor escrito: es un interés, se queda.
    await opp("42222222-2222-4222-8222-222222222222", "32222222-2222-4222-8222-222222222222", stages[1][0], "Seguimiento · Jorge", ", amount_cents", ", 9000")
    // «Contactado» con una próxima acción sin su tarea.
    await opp("43333333-3333-4333-8333-333333333333", "32222222-2222-4222-8222-222222222222", stages[1][0], "Ortodoncia",
      ", next_action_at, next_action_note", ", now() + interval '1 day', 'Llamar a Jorge'")
    // «Cita agendada» con su seguimiento y otra tarea abierta más.
    await opp("44444444-4444-4444-8444-444444444444", "32222222-2222-4222-8222-222222222222", stages[2][0], "Implante",
      ", next_action_at, assigned_user_id", ", now() + interval '2 day', 'u1'")
    await q(`insert into task (id, organization_id, contact_id, opportunity_id, title, kind, created_by, due_at, assignee_user_id)
      values ('51111111-1111-4111-8111-111111111111', 'legacy', '32222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444', 'Seguimiento: Implante', 'opportunity_follow_up', 'user', now() + interval '2 day', 'u1'),
             ('52222222-2222-4222-8222-222222222222', 'legacy', '32222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444', 'Enviar fotos', 'manual', 'user', null, null)`)
    // Cierres con texto libre.
    await opp("45555555-5555-4555-8555-555555555555", "32222222-2222-4222-8222-222222222222", stages[4][0], "Carillas",
      ", status, closed_at, close_reason", ", 'lost', now(), 'Muy caro'")
    await opp("46666666-6666-4666-8666-666666666666", "32222222-2222-4222-8222-222222222222", stages[3][0], "Limpieza",
      ", status, closed_at, close_reason", ", 'won', now(), 'Pagó'")
    // Lo que dejó «Seguimiento sin responsable».
    await q(`insert into automation_rule (id, organization_id, name, kind) values ('61111111-1111-4111-8111-111111111111', 'legacy', 'Seguimiento sin responsable', 'seguimientos_sin_responsable')`)
    await q(`insert into task (id, organization_id, contact_id, title, kind, created_by, area)
      values ('53333333-3333-4333-8333-333333333333', 'legacy', '32222222-2222-4222-8222-222222222222', 'Asignar responsable al seguimiento de Jorge', 'manual', 'admin', 'administracion')`)
    await q(`insert into automation_job (organization_id, rule_id, kind, dedupe_key, scheduled_for, status, task_id)
      values ('legacy', '61111111-1111-4111-8111-111111111111', 'seguimientos_sin_responsable', 'seguimientos_sin_responsable:x', now(), 'tarea', '53333333-3333-4333-8333-333333333333')`)

    await apply("0086_ventas_que_se_mueven_solas.sql")

    const rows = async (text: string) => [...(await q(text))] as Array<Record<string, unknown>>
    // La automática se borró; su nota sigue en la persona.
    expect(await rows(`select id from opportunity where id = '41111111-1111-4111-8111-111111111111'`)).toEqual([])
    expect(await rows(`select opportunity_id from crm_note where body = 'Saludó'`)).toEqual([{ opportunity_id: null }])
    // Cuatro pasos fijos, con sus nombres.
    expect(await rows(`select name, moment, position from pipeline_stage order by position`)).toEqual([
      { name: "Interesado", moment: "interesado", position: 0 },
      { name: "Evaluación agendada", moment: "evaluacion_agendada", position: 1 },
      { name: "Presupuesto enviado", moment: "presupuesto_enviado", position: 2 },
      { name: "Decidió", moment: "decidio", position: 3 },
    ])
    const where = await rows(`select o.title, s.moment, o.status, o.close_reason, o.close_note from opportunity o
      join pipeline_stage s on s.id = o.stage_id order by o.title`)
    expect(where).toEqual([
      { title: "Carillas", moment: "decidio", status: "lost", close_reason: "otro", close_note: "Muy caro" },
      { title: "Implante", moment: "evaluacion_agendada", status: "open", close_reason: null, close_note: null },
      { title: "Limpieza", moment: "decidio", status: "won", close_reason: "acepto", close_note: "Pagó" },
      { title: "Ortodoncia", moment: "interesado", status: "open", close_reason: null, close_note: null },
      { title: "Seguimiento · Jorge", moment: "interesado", status: "open", close_reason: null, close_note: null },
    ])
    // La próxima acción es una tarea, y solo una por oportunidad.
    expect(await rows(`select title, area, assignee_user_id from task where opportunity_id = '43333333-3333-4333-8333-333333333333'`)).toEqual([
      { title: "Llamar a Jorge", area: "recepcion", assignee_user_id: null },
    ])
    expect(await rows(`select id from task where opportunity_id = '44444444-4444-4444-8444-444444444444' and status = 'open'`)).toEqual([
      { id: "51111111-1111-4111-8111-111111111111" },
    ])
    expect(await rows(`select opportunity_id, contact_id from task where id = '52222222-2222-4222-8222-222222222222'`)).toEqual([
      { opportunity_id: null, contact_id: "32222222-2222-4222-8222-222222222222" },
    ])
    // La línea retirada: su tarea se cerró sola; su estado y sus casos ya no están.
    expect(await rows(`select status, settled_reason from task where id = '53333333-3333-4333-8333-333333333333'`)).toEqual([
      { status: "done", settled_reason: "la línea «Seguimiento sin responsable» se retiró: una oportunidad sin responsable es de Recepción" },
    ])
    expect(await rows(`select id from automation_rule where kind = 'seguimientos_sin_responsable'`)).toEqual([])
    expect(await rows(`select id from automation_job where kind = 'seguimientos_sin_responsable'`)).toEqual([])
    // Una tarea abierta más para la misma oportunidad ya no entra.
    await expect(q(`insert into task (organization_id, contact_id, opportunity_id, title, created_by)
      values ('legacy', '32222222-2222-4222-8222-222222222222', '44444444-4444-4444-8444-444444444444', 'Otra', 'user')`)).rejects.toThrow()
    // Un paso fuera de los cuatro, tampoco.
    await expect(q(`insert into pipeline_stage (organization_id, pipeline_id, name, position, moment)
      values ('legacy', '11111111-1111-4111-8111-111111111111', 'Contactado', 4, 'contactado')`)).rejects.toThrow()
  } finally {
    await container.stop()
  }
}, 240_000)

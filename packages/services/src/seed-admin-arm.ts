/**
 * Semilla manual del ARM de la administración (ADR 0184): clientes en cada
 * etapa, sus personas, tareas, propuestas, envíos, correos que llegan, un
 * documento, lo que cargó la skill (con un informe que no se sabe si salió) y
 * lo que prepara Kairós, para recorrer Hoy, Clientes, Embudo, Kairós y
 * Reportes en local.
 *
 * Solo manual (seed-dev la llama al final, cuando ya existen las cuentas de la
 * semilla y las demos para presentar); NUNCA en CI ni importada por tests.
 * Todo se hace con las operaciones de los servicios (las mismas de la
 * pantalla, la ruta firmada del correo y la pasada de Kairós); los únicos
 * cambios directos mueven fechas (para que la historia tenga días distintos),
 * anotan la carga de la configuración como la deja la skill en el servidor
 * (sin correr la carga entera), marcan la propuesta «por aprobar» (hoy solo Administración arma
 * propuestas, así que no se llega a ese estado por la operación) y escriben
 * «Lo que hay que saber» como lo guarda el worker de Kairós.
 *
 * Idempotente: cada cliente se reconoce por el correo de su persona y su
 * historia se siembra una sola vez; al volver a correrla solo se mueven las
 * tareas abiertas al día que les toca y Kairós hace su pasada (que es
 * idempotente por su clave). Nombres y datos ficticios, «(ficticia)» o
 * «(ficticio)»; correos `@example.test`. No envía correos ni mensajes: lo que
 * figura «enviado» es parte del ejemplo.
 */
import { type ClinicalProduct, productWords } from "@odentia/clinical"
import type { Db } from "@odentia/db"
import {
  kairosItem,
  type SaasClientOrigin,
  saasClient,
  saasClientContact,
  saasClientFile,
  saasOpportunity,
  saasProposal,
  saasTask,
} from "@odentia/db/schema/admin-arm"
import { adminAudit } from "@odentia/db/schema/admin-core"
import { saasDemo } from "@odentia/db/schema/admin-demos"
import { organization, user } from "@odentia/db/schema/auth"
import { saasFollowUp, saasPlan } from "@odentia/db/schema/saas-billing"
import { and, asc, desc, eq, inArray, isNotNull, isNull, like, ne, sql } from "drizzle-orm"
import { PDFDocument, StandardFonts } from "pdf-lib"
import { clientFileKey, registerClientFile } from "./admin-client-files.js"
import {
  addClientContact,
  createClient,
  linkClientToOrganization,
  linkContactToUser,
  updateClient,
  updateClientContact,
} from "./admin-clients.js"
import { type AdminActor, writeAdminAudit } from "./admin-core.js"
import { assignInboundEmail, ingestInboundEmail } from "./admin-inbound-email.js"
import {
  decideKairosItem,
  type KairosExecutors,
  kairosRulesPass,
  settleKairosOutreach,
} from "./admin-kairos.js"
import {
  draftPendingKairosItems,
  type KairosDraftWriter,
  type KairosWeeklyWriter,
  writeKairosWeekly,
} from "./admin-kairos-drafts.js"
import {
  addActivity,
  completeClientTask,
  createClientTask,
  createSaasProposal,
  decide,
  decideSaasProposal,
  markOutreachSent,
  type OutreachRow,
  prepareOutreach,
  recordPresentation,
  resolveOutreach,
  schedulePresentation,
} from "./admin-sales.js"
import {
  finishProgressReport,
  listProgressReports,
  productMailDomain,
  progressReportPdfKey,
  reserveProgressReport,
} from "./clinic-progress-report.js"
import { limaDate } from "./peru-business-days.js"
import { addDays as addCivilDays, dayStart } from "./report-periods.js"
import { markDemoOpened } from "./saas-demos.js"
import { SEED_STAFF_ADMIN_ID, SEED_STAFF_SUPPORT_ID } from "./seed-admin-core.js"
import type { Storage } from "./storage.js"

const DAY = 86_400_000
const HOUR = 3_600_000
const LIMA = "America/Lima"

const ADA: AdminActor = { userId: SEED_STAFF_ADMIN_ID, role: "admin" }
const SOFIA: AdminActor = { userId: SEED_STAFF_SUPPORT_ID, role: "support" }

/** El plan de lista de cada producto en la semilla (`seed-saas-billing.ts`). */
const PLAN_CODES: Record<ClinicalProduct, string> = {
  dental: "odentia-ficticio",
  medical: "latidia-ficticio",
  optical: "vistia-ficticio",
}

/* ---------- Fechas ---------- */

class Clock {
  readonly today: string
  constructor(readonly now: Date) {
    this.today = limaDate(now)
  }

  /** El día de Lima a `offset` días de hoy. */
  day(offset: number): string {
    return addCivilDays(this.today, offset)
  }

  /** Hace `days` días (negativo: en el futuro), como instante. */
  ago(days: number, hours = 0): Date {
    return new Date(this.now.getTime() - days * DAY - hours * HOUR)
  }

  /** Ese día de Lima a esa hora de Lima. */
  at(offset: number, hour: number): Date {
    const [year, month, day] = this.day(offset).split("-").map(Number) as [number, number, number]
    return new Date(dayStart(LIMA, year, month, day).getTime() + hour * HOUR)
  }
}

/* ---------- Clientes ---------- */

interface ProspectSpec {
  name: string
  product: ClinicalProduct
  origin: SaasClientOrigin
  originDetail?: string
  city: string
  owner: AdminActor
  /** Hace cuántos días fue el primer contacto. */
  sinceDays: number
  contact: { name: string; email: string; phone?: string }
  referredByClientId?: string | null
}

interface Seeded {
  id: string
  contactId: string
  /** Se creó en esta corrida: su historia se siembra ahora. */
  created: boolean
}

/** El cliente de esa persona (por su correo) o uno nuevo con `createClient`, con su primer contacto en su día. */
async function ensureProspect(tx: Db, clock: Clock, spec: ProspectSpec): Promise<Seeded> {
  const [found] = await tx
    .select({ id: saasClientContact.clientId, contactId: saasClientContact.id })
    .from(saasClientContact)
    .where(eq(saasClientContact.email, spec.contact.email))
    .limit(1)
  if (found) return { id: found.id, contactId: found.contactId, created: false }
  const { id } = await createClient(tx, ADA, {
    name: spec.name,
    product: spec.product,
    origin: spec.origin,
    ...(spec.originDetail ? { originDetail: spec.originDetail } : {}),
    ...(spec.referredByClientId ? { referredByClientId: spec.referredByClientId } : {}),
    city: spec.city,
    ownerUserId: spec.owner.userId,
    contact: spec.contact,
    // Ficticios con nombres distintos: si se parecen a otro, igual es otro.
    confirmNew: true,
  })
  // La semilla cuenta una historia de días: el primer contacto fue hace `sinceDays`.
  const since = clock.ago(spec.sinceDays)
  await tx.update(saasClient).set({ createdAt: since }).where(eq(saasClient.id, id))
  await tx
    .update(saasOpportunity)
    .set({ createdAt: since })
    .where(and(eq(saasOpportunity.clientId, id), isNull(saasOpportunity.decision)))
  await tx
    .update(saasClientContact)
    .set({ createdAt: since })
    .where(eq(saasClientContact.clientId, id))
  const [contact] = await tx
    .select({ id: saasClientContact.id })
    .from(saasClientContact)
    .where(and(eq(saasClientContact.clientId, id), eq(saasClientContact.isPrimary, true)))
    .limit(1)
  if (!contact) throw new Error(`La semilla no encontró la persona de ${spec.name}`)
  return { id, contactId: contact.id, created: true }
}

/**
 * Una tarea abierta de la semilla en su día: la crea la primera vez y, al
 * volver a sembrar otro día, la mueve al día que le toca (si nadie la cerró).
 */
async function keepTask(
  tx: Db,
  clock: Clock,
  client: Seeded,
  actor: AdminActor,
  task: {
    kind: "llamar" | "escribir" | "propuesta" | "alta" | "cobro" | "otro"
    title: string
    dueIn: number
    assignee: AdminActor
    contactId?: string | null
  },
): Promise<void> {
  const dueOn = clock.day(task.dueIn)
  if (client.created) {
    await createClientTask(
      tx,
      actor,
      client.id,
      {
        kind: task.kind,
        title: task.title,
        dueOn,
        assigneeUserId: task.assignee.userId,
        contactId: task.contactId ?? null,
      },
      clock.now,
    )
    return
  }
  await tx
    .update(saasTask)
    .set({ dueOn, updatedAt: clock.now })
    .where(
      and(
        eq(saasTask.clientId, client.id),
        eq(saasTask.title, task.title),
        eq(saasTask.status, "abierta"),
        eq(saasTask.byKairos, false),
        ne(saasTask.dueOn, dueOn),
      ),
    )
}

/** Una presentación que ya pasó y se hizo: la tarea agendada y su resultado, en sus días. */
async function pastPresentation(
  tx: Db,
  clock: Clock,
  client: Seeded,
  actor: AdminActor,
  daysAgo: number,
  body: string,
): Promise<void> {
  const task = await schedulePresentation(
    tx,
    actor,
    client.id,
    {
      dueOn: clock.day(-daysAgo),
      dueAt: clock.at(-daysAgo, 11),
      contactId: client.contactId,
      assigneeUserId: actor.userId,
    },
    clock.ago(daysAgo + 2),
  )
  await recordPresentation(
    tx,
    actor,
    task.id,
    { outcome: "se_hizo", body },
    new Date(clock.at(-daysAgo, 12).getTime()),
  )
}

/** Confirma los papeles de la persona principal (decir sus papeles los confirma). */
async function confirmRoles(
  tx: Db,
  actor: AdminActor,
  contactId: string,
  patch: {
    roles: Array<"decide" | "usa" | "paga">
    title?: string
    preferredChannel?: "whatsapp" | "correo" | "llamada"
  },
): Promise<void> {
  await updateClientContact(tx, actor, contactId, patch)
}

async function planIdOf(tx: Db, product: ClinicalProduct): Promise<string | null> {
  const [plan] = await tx
    .select({ id: saasPlan.id })
    .from(saasPlan)
    .where(eq(saasPlan.code, PLAN_CODES[product]))
    .limit(1)
  return plan?.id ?? null
}

/** La demo para presentar de la semilla de ese producto (si seed-dev ya la armó). */
async function seedDemoOf(tx: Db, product: ClinicalProduct): Promise<string | null> {
  const [demo] = await tx
    .select({ id: saasDemo.id })
    .from(saasDemo)
    .where(
      and(
        eq(saasDemo.product, product),
        like(saasDemo.slug, "seed-%"),
        isNotNull(saasDemo.organizationId),
      ),
    )
    .orderBy(asc(saasDemo.createdAt))
    .limit(1)
  return demo?.id ?? null
}

/* ---------- Lo que redacta Kairós sin modelo ---------- */

/** Para qué es cada mensaje, en la frase que lo abre. */
const GOAL_WORDS: Record<string, string> = {
  primera_respuesta:
    "gracias por dejar tu solicitud. ¿Te viene bien una llamada corta esta semana?",
  recordar_invitacion:
    "tu invitación para abrir tu cuenta vence pronto. Si te ayudo con algo, dime.",
  recordar_propuesta:
    "te escribo porque la propuesta que te enviamos vence pronto. ¿Pudiste revisarla?",
  retomar: "quedamos en volver a conversar por estas fechas. ¿Cómo va todo?",
  pedir_archivos:
    "para cargar tus datos nos faltan los archivos que pedimos en la carta de bienvenida.",
  recordar_equipo: "parte de tu equipo aún no aceptó su invitación. ¿Les reenvío el enlace?",
}

/**
 * El doble determinista del escritor de Kairós: redacta con plantillas y lo
 * dice (`drafter: "plantilla"`), como cuando el modelo no está configurado.
 */
const TEMPLATE_WRITER: KairosDraftWriter & KairosWeeklyWriter = {
  drafter: "plantilla",
  async draftMessage({ client, contact, channel, goal, senderName }) {
    const first = contact?.name.split(" ")[0] ?? ""
    const opening = GOAL_WORDS[goal] ?? "te escribo para seguir conversando."
    const brand = productWords(client.product).name
    // «El equipo de odentIA» ya dice la marca: no repetirla.
    const signature = senderName.includes(brand) ? senderName : `${senderName}, ${brand}`
    const body = `Hola${first ? `, ${first}` : ""}: ${opening}\n\n${signature}`
    return channel === "correo"
      ? { subject: `${client.name}: seguimos en contacto`, body }
      : { body }
  },
  async presentationScript({ client, facts, demo }) {
    const brand = productWords(client.product).name
    const lines = [
      `1. Abrir con lo que nos contó ${client.name}.`,
      `2. Mostrar ${demo ? `la demo ${demo.name}` : `${brand} con datos de ejemplo`}: agenda, mensajes y cobros.`,
      "3. Preguntar qué le preocupa hoy y cómo trabaja su equipo.",
      "4. Cerrar con el próximo paso y su fecha.",
      ...facts.slice(0, 2).map((fact) => `Para tener en cuenta: ${fact}`),
    ]
    return { script: lines.join("\n") }
  },
  async weeklySummary({ figures }) {
    const cited = figures
      .slice(0, 6)
      .map((figure) => `${figure.label}: ${figure.words}.`)
      .join(" ")
    return {
      text: `Resumen de la semana hecho con plantilla (el modelo no está configurado). ${cited}`,
    }
  },
}

/** Las operaciones de la pantalla que ejecuta un sí, como las pasa la ruta de Kairós. */
function executorsAt(now: Date): KairosExecutors<OutreachRow> {
  return {
    prepareOutreach: (tx, actor, clientId, input) =>
      prepareOutreach(tx, actor, clientId, input, now),
    updateClient: (tx, actor, clientId, patch) => updateClient(tx, actor, clientId, patch),
    linkContactToUser: (tx, actor, contactId, userId) =>
      linkContactToUser(tx, actor, contactId, userId),
    assignInboundEmail: (tx, actor, emailId, clientId) =>
      assignInboundEmail(tx, actor, emailId, clientId, now),
    recordPresentation: (tx, actor, taskId, input) =>
      recordPresentation(tx, actor, taskId, input, now),
    createProposal: (tx, actor, clientId, input) =>
      createSaasProposal(tx, actor, clientId, input, now),
  }
}

/* ---------- Documentos ---------- */

/** Un PDF de una hoja con una línea: lo justo para que el documento se abra. */
async function onePagePdf(line: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  const font = await pdf.embedFont(StandardFonts.Helvetica)
  pdf.addPage([595, 842]).drawText(line, { x: 56, y: 760, size: 14, font })
  return pdf.save()
}

/* ---------- La semilla ---------- */

export interface SeedAdminArmResult {
  clients: number
  kairos: { tasks: number; items: number; drafted: number }
}

/**
 * El ARM de la administración con datos para recorrerlo. Requiere el
 * personal de la semilla (`seedAdminCore`) y los planes y clínicas de cobro
 * (`seedSaasBillingDemo`); sin ellos no hace nada. `storage` sube la carta y
 * el PDF del informe; sin `putAttachmentAt`, se omiten.
 */
export async function seedAdminArm(
  tx: Db,
  storage: Pick<Storage, "putAttachmentAt">,
  now = new Date(),
): Promise<SeedAdminArmResult> {
  const clock = new Clock(now)
  const staff = await tx
    .select({ id: user.id })
    .from(user)
    .where(inArray(user.id, [ADA.userId, SOFIA.userId]))
  const orgs = await tx
    .select({ id: organization.id })
    .from(organization)
    .where(inArray(organization.id, ["seed-saas-prueba", "seed-saas-deuda", "seed-saas-cobrada"]))
  if (staff.length < 2 || orgs.length < 3)
    return { clients: 0, kairos: { tasks: 0, items: 0, drafted: 0 } }

  /* --- Con cuenta: las clínicas de cobro de la semilla, cada una con su cliente --- */
  const cobrada = await linkClientToOrganization(tx, ADA, {
    organizationId: "seed-saas-cobrada",
    origin: "web",
    now,
  })
  const deuda = await linkClientToOrganization(tx, ADA, {
    organizationId: "seed-saas-deuda",
    origin: "busqueda",
    now,
  })
  const prueba = await linkClientToOrganization(tx, ADA, {
    organizationId: "seed-saas-prueba",
    origin: "evento",
    now,
  })
  if (!cobrada || !deuda || !prueba)
    throw new Error("Las clínicas de cobro de la semilla son demos")
  await seedAccountPeople(tx, clock, { cobrada, deuda, prueba })

  /* --- Por vender: uno en cada etapa, de los tres productos --- */
  let clients = 3

  // Contacto (referido por Demo Cobrada): su persona, con los papeles por confirmar.
  const sonrisa = await ensureProspect(tx, clock, {
    name: "Sonrisa Total (ficticia)",
    product: "dental",
    origin: "referido",
    referredByClientId: cobrada,
    city: "Arequipa",
    owner: SOFIA,
    sinceDays: 3,
    contact: {
      name: "Paola Ríos (ficticia)",
      email: "paola.sonrisatotal@example.test",
      phone: "+51987100001",
    },
  })
  clients += 1
  if (sonrisa.created) {
    await addActivity(
      tx,
      SOFIA,
      sonrisa.id,
      {
        kind: "llamada",
        direction: "salio",
        body: "Le conté cómo funcionan la agenda y los recordatorios por WhatsApp.",
        outcome: "Quiere ver una presentación con su socia",
        contactId: sonrisa.contactId,
        happenedAt: clock.at(-1, 10),
      },
      now,
    )
    // Un correo que se cortó: no se sabe si salió y lo resuelve una persona.
    const uncertain = await prepareOutreach(
      tx,
      SOFIA,
      sonrisa.id,
      {
        channel: "correo",
        contactId: sonrisa.contactId,
        subject: "Lo que conversamos de odentIA",
        body: "Hola, Paola: te dejo el resumen de lo que conversamos y los horarios para la presentación.",
      },
      clock.ago(0, 20),
    )
    await markOutreachSent(tx, SOFIA, uncertain.id, "incierto", clock.ago(0, 20))
  }
  await keepTask(tx, clock, sonrisa, ADA, {
    kind: "llamar",
    title: "Llamar para agendar la presentación",
    dueIn: 0,
    assignee: SOFIA,
    contactId: sonrisa.contactId,
  })

  // Contacto que se enfría: escribió hace 10 días y nadie puso el próximo paso (Kairós lo ve).
  const huancayo = await ensureProspect(tx, clock, {
    name: "Clínica Dental Huancayo (ficticia)",
    product: "dental",
    origin: "whatsapp",
    city: "Huancayo",
    owner: SOFIA,
    sinceDays: 14,
    contact: {
      name: "Rubén Ccori (ficticio)",
      email: "ruben.huancayo@example.test",
      phone: "+51987100012",
    },
  })
  clients += 1
  if (huancayo.created) {
    await addActivity(
      tx,
      SOFIA,
      huancayo.id,
      {
        kind: "whatsapp",
        direction: "entro",
        body: "Pidió precios para dos odontólogos y preguntó si funciona sin internet.",
        contactId: huancayo.contactId,
        happenedAt: clock.at(-10, 17),
      },
      now,
    )
  }

  // Presentación agendada hoy con la demo de latidIA, que se abrió hoy: Kairós pregunta si se hizo.
  const vida = await ensureProspect(tx, clock, {
    name: "Centro Médico Vida (ficticio)",
    product: "medical",
    origin: "evento",
    originDetail: "Feria de salud de Lima (ficticia)",
    city: "Lima",
    owner: ADA,
    sinceDays: 6,
    contact: {
      name: "Raúl Medina (ficticio)",
      email: "raul.vida@example.test",
      phone: "+51987100002",
    },
  })
  clients += 1
  const medicalDemo = await seedDemoOf(tx, "medical")
  const presentedAt = limaDate(clock.ago(0, 1)) === clock.today ? clock.ago(0, 1) : now
  if (vida.created) {
    await confirmRoles(tx, ADA, vida.contactId, { roles: ["decide"], title: "Director médico" })
    await addClientContact(tx, ADA, vida.id, {
      name: "Lucía Paz (ficticia)",
      title: "Recepción",
      roles: ["usa"],
      email: "lucia.vida@example.test",
      preferredChannel: "whatsapp",
      phone: "+51987100022",
    })
    await addActivity(
      tx,
      ADA,
      vida.id,
      {
        kind: "reunion",
        direction: "salio",
        body: "Nos conocimos en la feria: tiene tres consultorios y agenda en cuaderno.",
        outcome: "Agendamos la presentación",
        contactId: vida.contactId,
        happenedAt: clock.at(-4, 16),
      },
      now,
    )
    await schedulePresentation(
      tx,
      ADA,
      vida.id,
      {
        dueOn: limaDate(presentedAt),
        dueAt: presentedAt,
        contactId: vida.contactId,
        demoId: medicalDemo,
      },
      clock.ago(4),
    )
  } else {
    await movePresentation(tx, vida.id, limaDate(presentedAt), presentedAt, clock)
  }
  if (medicalDemo) {
    // Abrir la demo cuenta como uso; con la de hoy, la tarea apunta a la demo vigente.
    await tx
      .update(saasTask)
      .set({ demoId: medicalDemo })
      .where(
        and(
          eq(saasTask.clientId, vida.id),
          eq(saasTask.kind, "presentacion"),
          eq(saasTask.status, "abierta"),
        ),
      )
    await markDemoOpened(tx, medicalDemo)
  }

  // Presentación agendada para dentro de unas horas con la demo de vistIA: Kairós prepara el guion.
  const mirada = await ensureProspect(tx, clock, {
    name: "Óptica Mirada (ficticia)",
    product: "optical",
    origin: "whatsapp",
    city: "Cusco",
    owner: SOFIA,
    sinceDays: 2,
    contact: {
      name: "Diego Huamán (ficticio)",
      email: "diego.mirada@example.test",
      phone: "+51987100003",
    },
  })
  clients += 1
  const opticalDemo = await seedDemoOf(tx, "optical")
  const upcoming = new Date(Math.ceil((now.getTime() + 20 * HOUR) / HOUR) * HOUR)
  if (mirada.created) {
    await confirmRoles(tx, SOFIA, mirada.contactId, { roles: ["decide", "paga"], title: "Dueño" })
    await addActivity(
      tx,
      SOFIA,
      mirada.id,
      {
        kind: "whatsapp",
        direction: "entro",
        body: "Escribió por WhatsApp: quiere ver cómo se guardan las recetas de lentes.",
        contactId: mirada.contactId,
        happenedAt: clock.at(-2, 12),
      },
      now,
    )
    await schedulePresentation(
      tx,
      SOFIA,
      mirada.id,
      {
        dueOn: limaDate(upcoming),
        dueAt: upcoming,
        contactId: mirada.contactId,
        demoId: opticalDemo,
      },
      clock.ago(1),
    )
    // Un WhatsApp abierto por su enlace: espera que la persona diga «¿Salió?».
    await prepareOutreach(
      tx,
      SOFIA,
      mirada.id,
      {
        channel: "whatsapp",
        contactId: mirada.contactId,
        body: "Hola, Diego: te confirmo la presentación de vistIA. Te mando el enlace un rato antes.",
      },
      clock.ago(0, 2),
    )
  } else {
    await movePresentation(tx, mirada.id, limaDate(upcoming), upcoming, clock)
  }
  if (opticalDemo) {
    await tx
      .update(saasTask)
      .set({ demoId: opticalDemo })
      .where(
        and(
          eq(saasTask.clientId, mirada.id),
          eq(saasTask.kind, "presentacion"),
          eq(saasTask.status, "abierta"),
        ),
      )
  }

  // Presentación hecha, con la propuesta en borrador.
  const arequipa = await ensureProspect(tx, clock, {
    name: "Clínica Dental Arequipa Sur (ficticia)",
    product: "dental",
    origin: "redes",
    originDetail: "Instagram",
    city: "Arequipa",
    owner: ADA,
    sinceDays: 12,
    contact: {
      name: "Carmen Flores (ficticia)",
      email: "carmen.arequipasur@example.test",
      phone: "+51987100004",
    },
  })
  clients += 1
  if (arequipa.created) {
    await confirmRoles(tx, ADA, arequipa.contactId, {
      roles: ["decide", "paga"],
      title: "Directora",
    })
    await addClientContact(tx, ADA, arequipa.id, {
      name: "Jorge Salinas (ficticio)",
      title: "Odontólogo",
      roles: ["usa"],
      email: "jorge.arequipasur@example.test",
    })
    await pastPresentation(
      tx,
      clock,
      arequipa,
      ADA,
      3,
      "Le gustó la agenda por unidad dental y los recordatorios; pidió ver cuánto costaría.",
    )
    const planId = await planIdOf(tx, "dental")
    if (planId) {
      await createSaasProposal(
        tx,
        ADA,
        arequipa.id,
        {
          planId,
          discountBps: 1000,
          discountMonths: 6,
          billingCycle: "mensual",
          validUntil: clock.day(15),
        },
        clock.ago(1),
      )
    }
  }
  await keepTask(tx, clock, arequipa, ADA, {
    kind: "escribir",
    title: "Enviar el video de la agenda",
    dueIn: -1,
    assignee: SOFIA,
    contactId: arequipa.contactId,
  })

  // Presentación hecha y una propuesta que pasó de lo que da el vendedor: espera aprobación.
  const piura = await ensureProspect(tx, clock, {
    name: "Óptica Central Piura (ficticia)",
    product: "optical",
    origin: "busqueda",
    city: "Piura",
    owner: SOFIA,
    sinceDays: 10,
    contact: {
      name: "Valeria Chávez (ficticia)",
      email: "valeria.centralpiura@example.test",
      phone: "+51987100011",
    },
  })
  clients += 1
  if (piura.created) {
    await confirmRoles(tx, SOFIA, piura.contactId, { roles: ["decide", "usa", "paga"] })
    await pastPresentation(
      tx,
      clock,
      piura,
      SOFIA,
      5,
      "Vio la venta de lentes y el taller; preguntó por un descuento si paga el año.",
    )
    const planId = await planIdOf(tx, "optical")
    if (planId) {
      const proposal = await createSaasProposal(
        tx,
        ADA,
        piura.id,
        {
          planId,
          discountBps: 4000,
          discountMonths: 12,
          billingCycle: "mensual",
          validUntil: clock.day(20),
        },
        clock.ago(1),
      )
      // Hoy solo Administración arma propuestas, así que la operación nunca la deja
      // «por aprobar»; la semilla la muestra como la armaría un vendedor (ADR 0184).
      await tx
        .update(saasProposal)
        .set({ status: "por_aprobar", updatedAt: now })
        .where(and(eq(saasProposal.id, proposal.id), eq(saasProposal.status, "borrador")))
    }
  }
  await keepTask(tx, clock, piura, ADA, {
    kind: "llamar",
    title: "Llamar para resolver las dudas del descuento",
    dueIn: 2,
    assignee: SOFIA,
    contactId: piura.contactId,
  })

  // Propuesta enviada y vigente; la clínica respondió por correo.
  const sanBorja = await ensureProspect(tx, clock, {
    name: "Consultorio San Borja (ficticio)",
    product: "medical",
    origin: "referido",
    originDetail: "La recomendó un colega de la feria (ficticio)",
    city: "Lima",
    owner: ADA,
    sinceDays: 15,
    contact: {
      name: "Patricia Núñez (ficticia)",
      email: "patricia.sanborja@example.test",
      phone: "+51987100005",
    },
  })
  clients += 1
  if (sanBorja.created) {
    await confirmRoles(tx, ADA, sanBorja.contactId, {
      roles: ["decide", "paga"],
      title: "Médica a cargo",
      preferredChannel: "correo",
    })
    await pastPresentation(
      tx,
      clock,
      sanBorja,
      ADA,
      9,
      "Le interesó la historia clínica y que Sofi confirme las citas.",
    )
    const done = await createClientTask(
      tx,
      ADA,
      sanBorja.id,
      { kind: "propuesta", title: "Armar y enviar la propuesta", dueOn: clock.day(-6) },
      clock.ago(8),
    )
    await completeClientTask(tx, ADA, done.id, { note: "Propuesta lista y enviada" }, clock.ago(4))
    await sendProposal(tx, sanBorja, {
      product: "medical",
      discountBps: 1500,
      discountMonths: 6,
      validUntil: clock.day(20),
      channel: "correo",
      at: clock.ago(4),
      subject: "Propuesta de latidIA para el Consultorio San Borja",
      body: "Hola, Patricia: te adjunto la propuesta que conversamos. Vale hasta la fecha que figura en ella.",
    })
  }
  await keepTask(tx, clock, sanBorja, ADA, {
    kind: "llamar",
    title: "Llamar para saber qué le pareció la propuesta",
    dueIn: -2,
    assignee: ADA,
    contactId: sanBorja.contactId,
  })

  // Propuesta enviada que vence en dos días: Kairós prepara el recordatorio.
  const chiclayo = await ensureProspect(tx, clock, {
    name: "Odonto Chiclayo (ficticia)",
    product: "dental",
    origin: "busqueda",
    city: "Chiclayo",
    owner: ADA,
    sinceDays: 20,
    contact: {
      name: "Hugo Castillo (ficticio)",
      email: "hugo.chiclayo@example.test",
      phone: "+51987100006",
    },
  })
  clients += 1
  if (chiclayo.created) {
    await confirmRoles(tx, ADA, chiclayo.contactId, {
      roles: ["decide", "paga"],
      preferredChannel: "correo",
    })
    await pastPresentation(
      tx,
      clock,
      chiclayo,
      ADA,
      14,
      "Trabaja con Excel; le preocupa pasar sus pacientes. Le contamos que los cargamos nosotros.",
    )
    await sendProposal(tx, chiclayo, {
      product: "dental",
      discountBps: 2000,
      discountMonths: 3,
      validUntil: clock.day(2),
      channel: "whatsapp",
      at: clock.ago(12),
      body: "Hola, Hugo: te envío la propuesta de odentIA que conversamos. Cualquier duda, me escribes.",
    })
  }
  await keepTask(tx, clock, chiclayo, ADA, {
    kind: "llamar",
    title: "Resolver las dudas de la propuesta",
    dueIn: 0,
    assignee: ADA,
    contactId: chiclayo.contactId,
  })

  // Propuesta aceptada: falta invitarla a abrir su cuenta.
  const trujillo = await ensureProspect(tx, clock, {
    name: "Visión Plus Trujillo (ficticia)",
    product: "optical",
    origin: "evento",
    originDetail: "Congreso de optometría (ficticio)",
    city: "Trujillo",
    owner: ADA,
    sinceDays: 25,
    contact: {
      name: "Rocío Benites (ficticia)",
      email: "rocio.visionplus@example.test",
      phone: "+51987100007",
    },
  })
  clients += 1
  if (trujillo.created) {
    await confirmRoles(tx, ADA, trujillo.contactId, { roles: ["decide"], title: "Gerente" })
    await addClientContact(tx, ADA, trujillo.id, {
      name: "Ernesto Benites (ficticio)",
      title: "Administración",
      roles: ["paga"],
      email: "ernesto.visionplus@example.test",
      preferredChannel: "correo",
    })
    await pastPresentation(
      tx,
      clock,
      trujillo,
      ADA,
      18,
      "Vio el examen de la vista y la venta de lentes; pidió una prueba más larga.",
    )
    const proposalId = await sendProposal(tx, trujillo, {
      product: "optical",
      discountBps: 2000,
      discountMonths: 6,
      trialDays: 45,
      trialCreditCents: 12000,
      validUntil: clock.day(10),
      channel: "correo",
      at: clock.ago(10),
      subject: "Propuesta de vistIA para Visión Plus",
      body: "Hola, Rocío: te adjunto la propuesta con la prueba de 45 días que pediste.",
    })
    if (proposalId) {
      await decideSaasProposal(
        tx,
        ADA,
        proposalId,
        { accepted: true, note: "Acepta con la prueba de 45 días" },
        clock.ago(1),
      )
    }
  }
  await keepTask(tx, clock, trujillo, ADA, {
    kind: "alta",
    title: "Invitarla a abrir su cuenta",
    dueIn: 3,
    assignee: ADA,
    contactId: trujillo.contactId,
  })

  // No por ahora, con el día para volver.
  const tacna = await ensureProspect(tx, clock, {
    name: "Dental Sur Tacna (ficticia)",
    product: "dental",
    origin: "whatsapp",
    city: "Tacna",
    owner: SOFIA,
    sinceDays: 30,
    contact: {
      name: "Milagros Quispe (ficticia)",
      email: "milagros.surtacna@example.test",
      phone: "+51987100008",
    },
  })
  clients += 1
  if (tacna.created) {
    await confirmRoles(tx, SOFIA, tacna.contactId, { roles: ["decide", "usa"] })
    await addActivity(
      tx,
      SOFIA,
      tacna.id,
      {
        kind: "llamada",
        direction: "salio",
        body: "Le gusta, pero abre su segunda sede en unos meses y prefiere empezar ahí.",
        contactId: tacna.contactId,
        happenedAt: clock.at(-20, 15),
      },
      now,
    )
    await decide(tx, ADA, tacna.id, {
      decision: "no_por_ahora",
      reason: "no_es_el_momento",
      reasonDetail: "Abre su segunda sede y prefiere empezar ahí",
      returnOn: clock.day(30),
    })
  }

  // Perdido, con su motivo.
  const ica = await ensureProspect(tx, clock, {
    name: "Policlínico Ica (ficticio)",
    product: "medical",
    origin: "busqueda",
    city: "Ica",
    owner: ADA,
    sinceDays: 40,
    contact: {
      name: "Fernando Rojas (ficticio)",
      email: "fernando.policlinicoica@example.test",
      phone: "+51987100009",
    },
  })
  clients += 1
  if (ica.created) {
    await confirmRoles(tx, ADA, ica.contactId, { roles: ["decide"] })
    await pastPresentation(tx, clock, ica, ADA, 30, "Vio la agenda y la historia clínica.")
    await decide(tx, ADA, ica.id, {
      decision: "perdido",
      reason: "precio",
      reasonDetail: "Le pareció caro para un solo consultorio",
    })
  }

  /* --- Correos que llegan: uno de un cliente y otro de nadie conocido --- */
  await ingestInboundEmail(
    tx,
    {
      mailbox: "contacto",
      product: "medical",
      messageId: "<seed-arm-correo-1@example.test>",
      from: "patricia.sanborja@example.test",
      fromName: "Patricia Núñez (ficticia)",
      to: `contacto@${productMailDomain("medical")}`,
      subject: "Re: Propuesta de latidIA para el Consultorio San Borja",
      text: "Gracias por la propuesta. ¿La prueba incluye los recordatorios por WhatsApp? (ejemplo ficticio)",
      receivedAt: clock.ago(0, 3),
      attachments: [],
    },
    now,
  )
  await ingestInboundEmail(
    tx,
    {
      mailbox: "contacto",
      product: "optical",
      messageId: "<seed-arm-correo-2@example.test>",
      from: "consultas.lentesdelsur@example.test",
      fromName: "Lentes del Sur (ficticia)",
      to: `contacto@${productMailDomain("optical")}`,
      subject: "¿Tienen agenda en línea para ópticas?",
      text: "Somos una óptica en Moquegua y queremos saber precios. (ejemplo ficticio)",
      receivedAt: clock.ago(0, 1),
      attachments: [],
    },
    now,
  )

  /* --- Documentos y lo que cargó la skill --- */
  await seedOnboardingFiles(tx, clock, storage, { prueba, deuda })

  /* --- Kairós: su pasada, sus borradores, lo que ya se decidió, sus resúmenes y la semana --- */
  const pass = await kairosRulesPass(tx, now)
  const drafts = await draftPendingKairosItems(tx, TEMPLATE_WRITER, { limit: 50 }, now)
  await seedKairosDecisions(tx, now, chiclayo.id)
  await seedSummaries(tx, now, [sanBorja.id, arequipa.id])
  await writeKairosWeekly(tx, TEMPLATE_WRITER, now)

  return {
    clients,
    kairos: { tasks: pass.tasks, items: pass.items, drafted: drafts.drafted.length },
  }
}

/** Mueve la presentación abierta de la semilla a su día y hora, solo si el día cambió. */
async function movePresentation(
  tx: Db,
  clientId: string,
  dueOn: string,
  dueAt: Date,
  clock: Clock,
): Promise<void> {
  await tx
    .update(saasTask)
    .set({ dueOn, dueAt, updatedAt: clock.now })
    .where(
      and(
        eq(saasTask.clientId, clientId),
        eq(saasTask.kind, "presentacion"),
        eq(saasTask.status, "abierta"),
        ne(saasTask.dueOn, dueOn),
      ),
    )
}

/**
 * Arma una propuesta y la envía por correo o por WhatsApp (que «Salió»), en el
 * día `at`: la propuesta pasa a enviada con el envío. Devuelve su id.
 */
async function sendProposal(
  tx: Db,
  client: Seeded,
  input: {
    product: ClinicalProduct
    discountBps: number
    discountMonths?: number
    trialDays?: number
    trialCreditCents?: number
    validUntil: string
    channel: "correo" | "whatsapp"
    at: Date
    subject?: string
    body: string
  },
): Promise<string | null> {
  const planId = await planIdOf(tx, input.product)
  if (!planId) return null
  const proposal = await createSaasProposal(
    tx,
    ADA,
    client.id,
    {
      planId,
      discountBps: input.discountBps,
      discountMonths: input.discountMonths ?? null,
      trialDays: input.trialDays ?? null,
      trialCreditCents: input.trialCreditCents ?? null,
      billingCycle: "mensual",
      validUntil: input.validUntil,
    },
    new Date(input.at.getTime() - HOUR),
  )
  const outreach = await prepareOutreach(
    tx,
    ADA,
    client.id,
    {
      channel: input.channel,
      contactId: client.contactId,
      subject: input.subject ?? null,
      body: input.body,
      proposalId: proposal.id,
    },
    input.at,
  )
  if (input.channel === "correo") await markOutreachSent(tx, ADA, outreach.id, "enviado", input.at)
  else await resolveOutreach(tx, ADA, outreach.id, "salio", input.at)
  return proposal.id
}

/** Las personas de las clínicas con cuenta, con sus papeles; una tarea de cobro y lo hablado. */
async function seedAccountPeople(
  tx: Db,
  clock: Clock,
  ids: { cobrada: string; deuda: string; prueba: string },
): Promise<void> {
  const now = clock.now
  // Demo Cobrada: su persona llegó con la solicitud; aquí se confirman sus papeles.
  const [marta] = await tx
    .select({ id: saasClientContact.id })
    .from(saasClientContact)
    .where(
      and(
        eq(saasClientContact.clientId, ids.cobrada),
        eq(saasClientContact.email, "cobrada-demo@example.test"),
        eq(saasClientContact.rolesConfirmed, false),
      ),
    )
    .limit(1)
  if (marta) {
    await confirmRoles(tx, ADA, marta.id, { roles: ["decide", "paga"], title: "Directora" })
    await addActivity(
      tx,
      SOFIA,
      ids.cobrada,
      {
        kind: "reunion",
        direction: "salio",
        body: "Capacitación de la agenda con recepción: quedó lista para atender.",
        contactId: marta.id,
        happenedAt: clock.at(-3, 10),
      },
      now,
    )
  }
  const [deudaKnown] = await tx
    .select({ id: saasClientContact.id })
    .from(saasClientContact)
    .where(eq(saasClientContact.email, "gerencia.deuda@example.test"))
    .limit(1)
  if (!deudaKnown) {
    const gabriela = await addClientContact(tx, ADA, ids.deuda, {
      name: "Gabriela Soto (ficticia)",
      title: "Gerente",
      roles: ["decide", "paga"],
      email: "gerencia.deuda@example.test",
      phone: "+51987100031",
      preferredChannel: "correo",
    })
    await addClientContact(tx, ADA, ids.deuda, {
      name: "Mario León (ficticio)",
      title: "Odontólogo",
      roles: ["usa"],
      phone: "+51987100032",
    })
    await addActivity(
      tx,
      ADA,
      ids.deuda,
      {
        kind: "llamada",
        direction: "salio",
        body: "Le recordé el cobro del mes: dice que ya subió el comprobante.",
        contactId: gabriela.id,
        happenedAt: clock.at(-2, 11),
        adminOnly: true,
      },
      now,
    )
  }
  await keepTask(tx, clock, { id: ids.deuda, contactId: "", created: !deudaKnown }, ADA, {
    kind: "cobro",
    title: "Revisar el comprobante del mes",
    dueIn: 0,
    assignee: ADA,
  })
  const [pruebaKnown] = await tx
    .select({ id: saasClientContact.id })
    .from(saasClientContact)
    .where(eq(saasClientContact.email, "ines.prueba@example.test"))
    .limit(1)
  if (!pruebaKnown) {
    await addClientContact(tx, ADA, ids.prueba, {
      name: "Inés Vargas (ficticia)",
      title: "Dueña",
      roles: ["decide", "usa", "paga"],
      email: "ines.prueba@example.test",
      phone: "+51987100033",
    })
  }
}

/**
 * La carta de bienvenida de Demo Prueba (salió hace 8 días y no llegaron
 * archivos: Kairós lo ve) y, en Demo Deuda, lo que hizo la skill en el
 * servidor: la configuración cargada por Ada hace 3 días y el informe N.º 1,
 * que se intentó ayer y no se sabe si salió (con su PDF y su correo
 * guardados, para «Revisé en Zoho: salió» o «No salió: reenviar»). Kairós
 * pone la tarea urgente de revisarlo en Hoy.
 */
async function seedOnboardingFiles(
  tx: Db,
  clock: Clock,
  storage: Pick<Storage, "putAttachmentAt">,
  ids: { prueba: string; deuda: string },
): Promise<void> {
  const put = storage.putAttachmentAt?.bind(storage)
  if (!put) return
  const [letter] = await tx
    .select({ id: saasClientFile.id })
    .from(saasClientFile)
    .where(and(eq(saasClientFile.clientId, ids.prueba), eq(saasClientFile.kind, "carta")))
    .limit(1)
  if (!letter) {
    const bytes = await onePagePdf("Carta de bienvenida (ficticia) - Demo Prueba")
    const objectKey = clientFileKey(ids.prueba, "pdf")
    await put(objectKey, bytes, "application/pdf")
    const file = await registerClientFile(
      tx,
      ADA,
      {
        clientId: ids.prueba,
        kind: "carta",
        filename: "carta-de-bienvenida-demo-prueba.pdf",
        objectKey,
        contentType: "application/pdf",
        sizeBytes: bytes.byteLength,
        adminOnly: false,
      },
      clock.now,
    )
    await tx
      .update(saasClientFile)
      .set({ createdAt: clock.ago(8) })
      .where(eq(saasClientFile.id, file.id))
  }
  await seedClinicLoad(tx, clock, put, ids.deuda)
}

/** Lo que dejó la skill en Demo Deuda: la carga de su configuración y un informe a medias. */
async function seedClinicLoad(
  tx: Db,
  clock: Clock,
  put: NonNullable<Storage["putAttachmentAt"]>,
  clientId: string,
): Promise<void> {
  const orgId = "seed-saas-deuda"
  const [loaded] = await tx
    .select({ id: adminAudit.id })
    .from(adminAudit)
    .where(and(eq(adminAudit.organizationId, orgId), eq(adminAudit.action, "org.setup_import")))
    .limit(1)
  if (!loaded) {
    // Como la deja `runClinicSetup` al cargar (sus cifras, sin correr la carga entera).
    await writeAdminAudit(tx, ADA, {
      action: "org.setup_import",
      organizationId: orgId,
      metadata: { planSha256: "0".repeat(64), nueva: 20, cambia: 2, igual: 7, invitations: 0 },
    })
    await tx
      .update(adminAudit)
      .set({ createdAt: clock.ago(3) })
      .where(and(eq(adminAudit.organizationId, orgId), eq(adminAudit.action, "org.setup_import")))
  }
  if ((await listProgressReports(tx, orgId)).some((report) => report.number === 1)) return
  const [client] = await tx
    .select({ name: saasClient.name })
    .from(saasClient)
    .where(eq(saasClient.id, clientId))
    .limit(1)
  const clinic = client?.name ?? "Demo Deuda (ficticia)"
  const bytes = await onePagePdf(`Informe N.º 1 (ficticio) - ${clinic}`)
  const pdfKey = progressReportPdfKey(orgId, 1)
  await put(pdfKey, bytes, "application/pdf")
  const title = "Informe de avance del alta"
  const sending = {
    number: 1,
    to: "duena.deuda@example.test",
    subject: `${title} — ${clinic}`,
    stage: "Configuración cargada",
    pdfKey,
    mail: {
      brand: "odentia" as const,
      brandName: "odentIA",
      title,
      clinic,
      to: "Dra. Deuda (ficticia)",
      closing: "Lo que sigue lo puede hacer usted misma o escribirnos.",
      replyTo: `ada@${productMailDomain("dental")}`,
      signature: { name: "Ada (ficticia)" },
    },
  }
  await reserveProgressReport(tx, ADA, orgId, sending)
  await finishProgressReport(tx, ADA, orgId, { ...sending, state: "desconocido" })
  await tx
    .update(adminAudit)
    .set({ createdAt: clock.ago(1) })
    .where(and(eq(adminAudit.organizationId, orgId), eq(adminAudit.entityId, "informe-1")))
}

/**
 * Lo que ya se decidió de Kairós, una sola vez: Ada aprueba el recordatorio de
 * la propuesta que vence (sale por correo) y Sofía descarta una primera
 * respuesta. Así «Lo hecho» no está vacío.
 */
async function seedKairosDecisions(tx: Db, now: Date, chiclayoId: string): Promise<void> {
  const [decided] = await tx
    .select({ id: kairosItem.id })
    .from(kairosItem)
    .where(inArray(kairosItem.status, ["ejecutada", "descartada", "incierta", "fallida"]))
    .limit(1)
  if (decided) return
  const executors = executorsAt(now)
  const [reminder] = await tx
    .select({ id: kairosItem.id, payload: kairosItem.payload })
    .from(kairosItem)
    .where(
      and(
        eq(kairosItem.clientId, chiclayoId),
        eq(kairosItem.kind, "mensaje"),
        eq(kairosItem.status, "espera"),
      ),
    )
    .limit(1)
  if (reminder && typeof reminder.payload.body === "string") {
    const decision = await decideKairosItem(
      tx,
      ADA,
      reminder.id,
      { action: "aprobar" },
      executors,
      now,
    )
    if (decision.outreach) {
      if (decision.outreach.channel === "correo")
        await markOutreachSent(tx, ADA, decision.outreach.id, "enviado", now)
      else await resolveOutreach(tx, ADA, decision.outreach.id, "salio", now)
      await settleKairosOutreach(tx, decision.outreach.id)
    }
  }
  const [answer] = await tx
    .select({ id: kairosItem.id })
    .from(kairosItem)
    .where(
      and(
        eq(kairosItem.kind, "mensaje"),
        eq(kairosItem.status, "espera"),
        eq(kairosItem.adminOnly, false),
        sql`${kairosItem.payload} ->> 'goal' = 'primera_respuesta'`,
      ),
    )
    .orderBy(asc(kairosItem.createdAt))
    .limit(1)
  if (answer) await decideKairosItem(tx, SOFIA, answer.id, { action: "descartar" }, executors, now)
}

/**
 * «Lo que hay que saber» de dos clientes, con su fuente por frase, como lo
 * guarda la pasada del worker de Kairós (sin tocar `updated_at`). Solo si
 * todavía no tienen uno.
 */
async function seedSummaries(tx: Db, now: Date, clientIds: string[]): Promise<void> {
  for (const clientId of clientIds) {
    const [client] = await tx
      .select({ summary: saasClient.summary })
      .from(saasClient)
      .where(eq(saasClient.id, clientId))
      .limit(1)
    if (!client || client.summary) continue
    const activities = await tx
      .select({
        id: saasFollowUp.id,
        kind: saasFollowUp.kind,
        direction: saasFollowUp.direction,
        happenedAt: saasFollowUp.happenedAt,
      })
      .from(saasFollowUp)
      .where(and(eq(saasFollowUp.clientId, clientId), eq(saasFollowUp.adminOnly, false)))
      .orderBy(desc(saasFollowUp.happenedAt))
    const [proposal] = await tx
      .select({
        id: saasProposal.id,
        status: saasProposal.status,
        validUntil: saasProposal.validUntil,
      })
      .from(saasProposal)
      .where(eq(saasProposal.clientId, clientId))
      .orderBy(desc(saasProposal.version))
      .limit(1)
    const [task] = await tx
      .select({ id: saasTask.id, title: saasTask.title, dueOn: saasTask.dueOn })
      .from(saasTask)
      .where(and(eq(saasTask.clientId, clientId), eq(saasTask.status, "abierta")))
      .orderBy(asc(saasTask.dueOn))
      .limit(1)
    const sources: Array<{ text: string; source: string }> = []
    const presentation = activities.find((entry) => entry.kind === "presentacion")
    if (presentation)
      sources.push({
        text: `La presentación se hizo el ${limaDate(presentation.happenedAt)} y le interesó lo que vio.`,
        source: `actividad:${presentation.id}`,
      })
    const inbound = activities.find(
      (entry) => entry.kind === "correo" && entry.direction === "entro",
    )
    if (inbound)
      sources.push({
        text: "Respondió por correo con una pregunta sobre la prueba.",
        source: `actividad:${inbound.id}`,
      })
    if (proposal)
      sources.push({
        text:
          proposal.status === "enviada"
            ? `Tiene la propuesta enviada, que vale hasta el ${proposal.validUntil}.`
            : "Su propuesta está en borrador: todavía no se envió.",
        source: `propuesta:${proposal.id}`,
      })
    if (task)
      sources.push({
        text: `Lo que sigue: ${task.title.toLowerCase()} (para el ${task.dueOn}).`,
        source: `tarea:${task.id}`,
      })
    if (sources.length === 0) continue
    await tx.execute(sql`update saas_client set summary = ${sources.map((item) => item.text).join(" ")},
        summary_sources = ${JSON.stringify(sources)}::jsonb, summary_at = ${now.toISOString()}::timestamptz
      where id = ${clientId}::uuid`)
    await writeAdminAudit(tx, null, {
      action: "kairos.summary_written",
      entityId: clientId,
      metadata: { clientId, sources: sources.length },
    })
  }
}

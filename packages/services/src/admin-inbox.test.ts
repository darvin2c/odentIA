import type { Db } from "@odentia/db"
import {
  kairosChatTurn,
  kairosItem,
  saasChat,
  saasClient,
  saasClientContact,
  saasInboundEmail,
  saasOutreach,
} from "@odentia/db/schema/admin-arm"
import { adminAudit, adminStaff } from "@odentia/db/schema/admin-core"
import { user } from "@odentia/db/schema/auth"
import { saasFollowUp } from "@odentia/db/schema/saas-billing"
import { and, asc, eq, inArray, type SQL, sql } from "drizzle-orm"
import { beforeAll, describe, expect, it } from "vitest"
import { chatReplyOutbound, skipChatOutreach } from "./admin-chat-send.js"
import { clientFileKey, deleteClientFile, registerClientFile } from "./admin-client-files.js"
import type { AdminActor } from "./admin-core.js"
import { firstIdSql } from "./admin-email-thread.js"
import {
  applyChatStatus,
  assignChat,
  getChat,
  type InboundChatInput,
  ingestInboundChat,
  markChatNotClinic,
  markChatOutreachFailed,
  markChatOutreachSent,
  markChatOutreachUncertain,
  prepareChatReply,
  prepareKairosChatReply,
} from "./admin-inbound-chat.js"
import {
  getInboundEmail,
  type InboundEmailInput,
  ingestInboundEmail,
} from "./admin-inbound-email.js"
import {
  attendEmailThread,
  chatConversationState,
  emailThreadKeySql,
  getEmailThread,
  type InboxItem,
  inboxCounts,
  listInbox,
  outreachThreadKeyOf,
  outreachThreadKeySql,
  settleConversation,
  type ThreadHeaders,
  threadKeyOf,
  unsettleConversation,
} from "./admin-inbox.js"
import { KAIROS_TEMPLATE_NOTE, listKairosItems } from "./admin-kairos.js"
import { markOutreachSent, prepareEmailReply } from "./admin-sales.js"
import { kairosImproveContext } from "./kairos-improve.js"
import { insertOrg, ownerDb, setupTestDb } from "./test-setup.js"

/**
 * La Bandeja de la administración (ADR 0196) contra Postgres real: el hilo de un correo, el
 * estado de cada conversación, la lista con sus números, las marcas de una persona, responder un
 * chat con archivos y lo que dice el chat de lo que salió.
 */
setupTestDb()
const NOW = new Date()
const MIN = 60_000
const HOUR = 60 * MIN
const MB = 1024 * 1024
const admin: AdminActor = { userId: "ib-admin", role: "admin" }
const other: AdminActor = { userId: "ib-otra", role: "admin" }
const support: AdminActor = { userId: "ib-soporte", role: "support" }
const ORG = "ib-org"
let sales: string
let clinic: string
let stranger: string

const ago = (ms: number) => new Date(NOW.getTime() - ms)
const later = (ms: number) => new Date(NOW.getTime() + ms)

function mail(overrides: Partial<InboundEmailInput> = {}): InboundEmailInput {
  return {
    mailbox: "hola",
    product: "dental",
    messageId: `<${crypto.randomUUID()}@clinica.test>`,
    from: "alguien@nadie.test",
    fromName: "Rosa Mamani",
    to: "hola@odentia32.com",
    subject: "Quiero saber más",
    text: "Hola,\n¿cuánto cuesta?",
    receivedAt: ago(HOUR),
    attachments: [],
    senderVerified: true,
    ...overrides,
  }
}

let phoneSeq = 0
/** Un celular distinto por conversación. */
function phone(): string {
  phoneSeq += 1
  return `+5193300${String(phoneSeq).padStart(4, "0")}`
}

/** Un mensaje que llegó (`now`: cuándo lo guardamos; `receivedAt`: la hora de Meta). */
function wrote(overrides: Partial<InboundChatInput> = {}, now = NOW) {
  return ingestInboundChat(
    ownerDb,
    {
      channel: "whatsapp",
      address: phone(),
      externalId: `wamid.${crypto.randomUUID()}`,
      body: "Hola, ¿cómo funciona?",
      media: [],
      receivedAt: new Date(now.getTime() - MIN),
      ...overrides,
    },
    now,
  )
}

async function client(name: string, organizationId?: string): Promise<string> {
  const [row] = await ownerDb
    .insert(saasClient)
    .values({ name, product: "dental", organizationId })
    .returning({ id: saasClient.id })
  if (!row) throw new Error("sin cliente")
  return row.id
}

/** Un documento del cliente, con la clave donde quedaría en el bucket. */
async function file(clientId: string, filename: string, contentType: string, sizeBytes = MB) {
  const objectKey = clientFileKey(clientId, filename.split(".").at(-1) ?? "bin")
  const row = await registerClientFile(ownerDb, admin, {
    clientId,
    kind: "otro",
    filename,
    objectKey,
    contentType,
    sizeBytes,
    adminOnly: true,
  })
  return { ...row, objectKey }
}

async function outreachOfChat(chatId: string) {
  return ownerDb
    .select()
    .from(saasOutreach)
    .where(eq(saasOutreach.chatId, chatId))
    .orderBy(asc(saasOutreach.createdAt), asc(saasOutreach.id))
}

async function audits(action: string, entityId: string) {
  return ownerDb
    .select()
    .from(adminAudit)
    .where(and(eq(adminAudit.action, action), eq(adminAudit.entityId, entityId)))
    .orderBy(asc(adminAudit.createdAt))
}

/** Lo que dice la lista de una conversación (con su cliente, para no traer las de otras pruebas). */
async function listed(
  kind: "chat" | "correo",
  id: string,
  filter: Parameters<typeof listInbox>[2] = {},
  now = NOW,
): Promise<InboxItem | undefined> {
  const { items } = await listInbox(ownerDb, admin, { limit: 100, ...filter }, now)
  return items.find((item) => item.kind === kind && item.id === id)
}

beforeAll(async () => {
  await ownerDb.insert(user).values([
    { id: admin.userId, name: "Ada Lovelace", email: "ada@bandeja.test" },
    { id: other.userId, name: "Beto Paz", email: "beto@bandeja.test" },
    { id: support.userId, name: "Sofía Soporte", email: "sofia@bandeja.test" },
  ])
  await ownerDb.insert(adminStaff).values([
    { userId: admin.userId, role: "admin" },
    { userId: other.userId, role: "admin" },
    { userId: support.userId, role: "support" },
  ])
  await insertOrg(ownerDb, ORG, "ib-clinica")
  sales = await client("Clínica en venta de la Bandeja (ficticia)")
  clinic = await client("Clínica con app de la Bandeja (ficticia)", ORG)
  stranger = await client("Otra clínica de la Bandeja (ficticia)")
  await ownerDb
    .insert(saasClientContact)
    .values([
      { clientId: sales, name: "Rosa Venta", email: "rosa.venta@bandeja.test", isPrimary: true },
    ])
})

describe("el hilo de un correo", () => {
  it("se arma por References, por el padre de su In-Reply-To o por su Message-ID; la SQL dice lo mismo", async () => {
    const e1 = await ingestInboundEmail(
      ownerDb,
      mail({
        messageId: "<e1.hilo@clinica.test>",
        from: "hilo@nadie.test",
        subject: "Precios",
        receivedAt: ago(3 * HOUR),
      }),
    )
    const r1 = await prepareEmailReply(ownerDb, admin, e1.id, { body: "Le cuento." }, ago(2 * HOUR))
    await markOutreachSent(ownerDb, admin, r1.id, "enviado", ago(2 * HOUR))
    const [r1Row] = await ownerDb.select().from(saasOutreach).where(eq(saasOutreach.id, r1.id))
    const r1Mid = r1Row?.messageId ?? ""
    expect(r1Mid).toMatch(/^<.+@.+>$/)
    // Responde nuestra respuesta, con la cadena entera.
    const e2 = await ingestInboundEmail(
      ownerDb,
      mail({
        messageId: "<e2.hilo@clinica.test>",
        from: "hilo@nadie.test",
        subject: "Re: Precios",
        inReplyTo: r1Mid,
        references: `<e1.hilo@clinica.test> ${r1Mid}`,
        receivedAt: ago(HOUR),
      }),
    )
    // Solo con In-Reply-To (sin References): la clave es la de su padre, nuestro envío.
    const e3 = await ingestInboundEmail(
      ownerDb,
      mail({
        messageId: "<e3.hilo@clinica.test>",
        from: "hilo@nadie.test",
        subject: "Re: Precios",
        inReplyTo: r1Mid,
        receivedAt: ago(30 * MIN),
      }),
    )
    // Responde un correo que no conocemos: su propio hilo.
    const e4 = await ingestInboundEmail(
      ownerDb,
      mail({
        messageId: "<e4.hilo@clinica.test>",
        from: "hilo@nadie.test",
        subject: "Otra cosa",
        inReplyTo: "<desconocido.hilo@otro.test>",
        receivedAt: ago(20 * MIN),
      }),
    )
    const ids = [e1.id, e2.id, e3.id, e4.id]
    const sqlKeys = new Map(
      [
        ...(await ownerDb.execute<{ id: string; key: string }>(
          sql`select e.id::text as id, ${emailThreadKeySql("e")} as key
            from admin.saas_inbound_email e where e.id in (${sql.join(
              ids.map((id) => sql`${id}::uuid`),
              sql`, `,
            )})`,
        )),
      ].map((row) => [row.id, row.key]),
    )
    const emails = await ownerDb
      .select()
      .from(saasInboundEmail)
      .where(inArray(saasInboundEmail.id, ids))
    const known = new Map<string, ThreadHeaders>([
      [r1Mid, { references: r1Row?.references ?? null, messageId: r1Mid }],
      ...emails.map(
        (email) =>
          [
            email.messageId,
            {
              references: email.references,
              inReplyTo: email.inReplyTo,
              messageId: email.messageId,
            },
          ] as const,
      ),
    ])
    // Quién está en cada hilo (lo que lee la SQL): quien lo empezó; del que no conocemos, quien
    // escribió primero apuntándole.
    const inThread = (key: string) =>
      ["<e1.hilo@clinica.test>", "<desconocido.hilo@otro.test>"].includes(key)
        ? ["hilo@nadie.test"]
        : []
    for (const email of emails) {
      const tsKey = threadKeyOf(
        {
          references: email.references,
          inReplyTo: email.inReplyTo,
          messageId: email.messageId,
          fromAddress: email.fromAddress,
          senderVerified: email.senderVerified,
        },
        (id) => known.get(id),
        inThread,
      )
      expect(sqlKeys.get(email.id)).toBe(tsKey)
    }
    expect(ids.map((id) => sqlKeys.get(id))).toEqual([
      "<e1.hilo@clinica.test>",
      "<e1.hilo@clinica.test>",
      "<e1.hilo@clinica.test>",
      "<desconocido.hilo@otro.test>",
    ])
    // Nuestra respuesta va en el hilo del correo que responde (la gemela en SQL, igual).
    const [outKey] = [
      ...(await ownerDb.execute<{ key: string }>(
        sql`select ${outreachThreadKeySql("o")} as key from admin.saas_outreach o where o.id = ${r1.id}::uuid`,
      )),
    ]
    expect(outKey?.key).toBe("<e1.hilo@clinica.test>")
    expect(
      outreachThreadKeyOf(
        { references: r1Row?.references ?? null, messageId: r1Mid },
        "<e1.hilo@clinica.test>",
      ),
    ).toBe("<e1.hilo@clinica.test>")

    // El hilo entero se abre desde cualquiera de sus correos y se responde el último que llegó.
    const thread = await getEmailThread(ownerDb, admin, e1.id, NOW)
    expect(thread).toMatchObject({
      emailId: e3.id,
      threadKey: "<e1.hilo@clinica.test>",
      subject: "Re: Precios",
      mailbox: "hola",
      client: null,
      state: "te_toca",
      stateWhy: null,
      reply: {
        emailId: e3.id,
        to: "hilo@nadie.test",
        subject: "Re: Precios",
        canReply: true,
        why: null,
      },
      rules: { channel: "correo", maxChars: 5000, formatting: "markdown" },
      draft: null,
    })
    expect(thread.reply.from).toContain("<ada.lovelace@")
    expect(thread.entries.map((entry) => [entry.kind, entry.id])).toEqual([
      ["entro", e1.id],
      ["salio", r1.id],
      ["entro", e2.id],
      ["entro", e3.id],
    ])
    expect(thread.entries[1]).toMatchObject({
      kind: "salio",
      status: "enviado",
      by: { id: admin.userId, name: "Ada Lovelace" },
      byKairos: false,
      canResolve: false,
      files: [],
    })
    expect((await getEmailThread(ownerDb, admin, e3.id, NOW)).threadKey).toBe(thread.threadKey)
    const alone = await getEmailThread(ownerDb, admin, e4.id, NOW)
    expect(alone.entries.map((entry) => entry.id)).toEqual([e4.id])

    // En la lista: una sola conversación, abierta por su último correo.
    const item = await listed("correo", e3.id, { cliente: "sin" })
    expect(item).toMatchObject({
      kind: "correo",
      channel: "correo",
      who: { name: "Rosa Mamani", address: "hilo@nadie.test" },
      subject: "Re: Precios",
      state: "te_toca",
      mailbox: "hola",
      to: "hola@odentia32.com",
      client: null,
      lastOutbound: { status: "enviado", byKairos: false },
    })
    expect(await listed("correo", e1.id, { cliente: "sin" })).toBeUndefined()

    // Le responde una persona: Respondida; si no se sabe si salió, lo dice.
    const r3 = await prepareEmailReply(ownerDb, admin, e3.id, { body: "Claro." }, NOW)
    expect(await listed("correo", e3.id, { cliente: "sin" })).toMatchObject({
      state: "respondida",
      stateWhy: null,
    })
    await markOutreachSent(ownerDb, admin, r3.id, "incierto", NOW)
    const unsure = await getEmailThread(ownerDb, admin, e1.id, NOW)
    expect(unsure).toMatchObject({
      state: "respondida",
      stateWhy: "No se sabe si salió tu respuesta",
    })
    expect(unsure.entries.at(-1)).toMatchObject({ id: r3.id, status: "incierto", canResolve: true })
  })

  it("la respuesta que dejó lista Kairós: te toca, lo dice y la trae para enviarla o cambiarla", async () => {
    const asked = await ingestInboundEmail(
      ownerDb,
      mail({ from: "borrador@nadie.test", subject: "¿Tienen agenda en línea?" }),
    )
    const [item] = await ownerDb
      .insert(kairosItem)
      .values({
        kind: "responder_correo",
        title: "Responder a Rosa Mamani",
        reason: "Le escribió a hola@ de odentIA",
        payload: {
          emailId: asked.id,
          body: "Hola, sí la tenemos.",
          draft: { subject: null, body: "Hola, sí la tenemos.", drafter: "plantilla" },
          draftNote: KAIROS_TEMPLATE_NOTE,
        },
        expectedState: {},
        idempotencyKey: `prueba:${crypto.randomUUID()}`,
        expiresAt: later(48 * HOUR),
        adminOnly: true,
      })
      .returning({ id: kairosItem.id })
    expect(await listed("correo", asked.id, { cliente: "sin" })).toMatchObject({
      state: "te_toca",
      stateWhy: "Kairós dejó la respuesta lista",
      draftReady: true,
    })
    const thread = await getEmailThread(ownerDb, admin, asked.id, NOW)
    expect(thread.draft).toEqual({
      itemId: item?.id,
      emailId: asked.id,
      subject: null,
      body: "Hola, sí la tenemos.",
      reason: "Le escribió a hola@ de odentIA",
      facts: [],
      drafter: "plantilla",
      note: KAIROS_TEMPLATE_NOTE,
    })
    // Se decide en la Bandeja: no sale en Kairós ni en Hoy, salvo que se pida.
    const plain = await listKairosItems(ownerDb, admin, { status: "espera" }, NOW)
    expect(plain.items.some((row) => row.id === item?.id)).toBe(false)
    const asked2 = await listKairosItems(
      ownerDb,
      admin,
      { status: "espera", conversations: true },
      NOW,
    )
    expect(asked2.items.some((row) => row.id === item?.id)).toBe(true)
  })

  it("quien conoce el Message-ID de un hilo ajeno no entra en él: su correo es su propia conversación", async () => {
    const own = await ingestInboundEmail(
      ownerDb,
      mail({
        messageId: "<v1.hilo@victima.test>",
        from: "rosa@victima.test",
        subject: "Mi cuenta",
        text: "Necesito cambiar la clave de mi cuenta",
        receivedAt: ago(3 * HOUR),
      }),
    )
    const r1 = await prepareEmailReply(
      ownerDb,
      admin,
      own.id,
      { body: "Te ayudamos." },
      ago(2 * HOUR),
    )
    await markOutreachSent(ownerDb, admin, r1.id, "enviado", ago(2 * HOUR))
    const [r1Row] = await ownerDb.select().from(saasOutreach).where(eq(saasOutreach.id, r1.id))
    const r1Mid = r1Row?.messageId ?? ""
    const headers = { inReplyTo: r1Mid, references: `<v1.hilo@victima.test> ${r1Mid}` }
    // Alguien de fuera con las cabeceras del hilo, y la clínica que sí responde, en mayúsculas.
    const spoof = await ingestInboundEmail(
      ownerDb,
      mail({
        ...headers,
        messageId: "<falso.hilo@malo.test>",
        from: "atacante@malo.test",
        subject: "Re: Mi cuenta",
        text: "Mándame los datos de acceso",
        receivedAt: ago(HOUR),
      }),
    )
    const answer = await ingestInboundEmail(
      ownerDb,
      mail({
        ...headers,
        messageId: "<v2.hilo@victima.test>",
        from: "Rosa@Victima.test",
        subject: "Re: Mi cuenta",
        receivedAt: ago(30 * MIN),
      }),
    )
    const thread = await getEmailThread(ownerDb, admin, own.id, NOW)
    expect(thread.threadKey).toBe("<v1.hilo@victima.test>")
    expect(thread.entries.map((entry) => entry.id)).toEqual([own.id, r1.id, answer.id])
    expect(thread.reply.emailId).toBe(answer.id)
    expect(thread.reply.to.toLowerCase()).toBe("rosa@victima.test")

    // El de fuera es su propia conversación: se le responde a él y solo con lo suyo.
    const alone = await getEmailThread(ownerDb, admin, spoof.id, NOW)
    expect(alone.threadKey).toBe("<falso.hilo@malo.test>")
    expect(alone.entries.map((entry) => entry.id)).toEqual([spoof.id])
    expect(alone.reply).toMatchObject({ emailId: spoof.id, to: "atacante@malo.test" })
    expect(await listed("correo", spoof.id, { cliente: "sin" })).toMatchObject({ state: "te_toca" })
    // Otro correo suyo con las mismas cabeceras tampoco entra (aunque el primero ya llegó).
    const again = await ingestInboundEmail(
      ownerDb,
      mail({ ...headers, messageId: "<falso2.hilo@malo.test>", from: "atacante@malo.test" }),
    )
    expect(
      (await getEmailThread(ownerDb, admin, again.id, NOW)).entries.map((entry) => entry.id),
    ).toEqual([again.id])

    // «Mejorar» lee el mismo hilo que la Bandeja: al de fuera no le llega lo de la clínica.
    const forSpoof = await kairosImproveContext(ownerDb, admin, { emailId: spoof.id })
    expect(JSON.stringify(forSpoof.conversation)).toContain("datos de acceso")
    expect(JSON.stringify(forSpoof.conversation)).not.toContain("cambiar la clave")
    expect(JSON.stringify(forSpoof.conversation)).not.toContain("Te ayudamos")
    const forClinic = await kairosImproveContext(ownerDb, admin, { emailId: answer.id })
    expect(JSON.stringify(forClinic.conversation)).toContain("cambiar la clave")
    expect(JSON.stringify(forClinic.conversation)).not.toContain("datos de acceso")
  })

  it("las cabeceras del hilo se buscan por sus índices: la misma expresión que la regla", async () => {
    // Cada búsqueda por el primer Message-ID, armada con la misma expresión de la regla
    // (`firstIdSql`): sin recorrer la tabla, el plan usa su índice de expresión.
    const planOf = (query: SQL) =>
      ownerDb.transaction(async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`)
        const rows = await tx.execute<{ "QUERY PLAN": string }>(sql`explain ${query}`)
        return [...rows].map((row) => row["QUERY PLAN"]).join("\n")
      })
    const key = sql.raw(`'<raiz.plan@nadie.test>'`)
    expect(
      await planOf(
        sql`select 1 from admin.saas_inbound_email fe where ${firstIdSql(sql.raw(`fe."references"`))} = ${key}`,
      ),
    ).toContain("saas_inbound_email_references_root_idx")
    expect(
      await planOf(
        sql`select 1 from admin.saas_inbound_email fe where ${firstIdSql(sql.raw("fe.in_reply_to"))} = ${key}`,
      ),
    ).toContain("saas_inbound_email_reply_root_idx")
    expect(
      await planOf(
        sql`select 1 from admin.saas_outreach rr where ${firstIdSql(sql.raw(`rr."references"`))} = ${key}`,
      ),
    ).toContain("saas_outreach_references_root_idx")
  })

  it("a quien le respondimos entra en el hilo con su primer correo; quien no, sigue aparte", async () => {
    const keyOf = async (emailId: string) =>
      (await getEmailThread(ownerDb, admin, emailId, NOW)).threadKey
    // «Escribir» a la clínica: el hilo empieza con lo nuestro, a contacto@.
    const o0 = "<o0.escribir@odentia32.com>"
    const [first] = await ownerDb
      .insert(saasOutreach)
      .values({
        clientId: sales,
        channel: "correo",
        toAddress: "contacto@clinica-c.test",
        subject: "Tu prueba de odentIA",
        body: "Hola, te cuento de la prueba.",
        messageId: o0,
        status: "enviado",
        sentAt: ago(5 * HOUR),
        createdBy: admin.userId,
        createdAt: ago(5 * HOUR),
      })
      .returning({ id: saasOutreach.id })
    // Responde la doctora, que no estaba en el hilo: su primer correo es su propia conversación.
    const d1 = await ingestInboundEmail(
      ownerDb,
      mail({
        messageId: "<d1.dra@clinica-c.test>",
        from: "dra@clinica-c.test",
        subject: "Re: Tu prueba de odentIA",
        inReplyTo: o0,
        references: o0,
        receivedAt: ago(4 * HOUR),
      }),
    )
    expect(await keyOf(d1.id)).toBe("<d1.dra@clinica-c.test>")
    // «Lo atiendo yo» con esa clave, antes de que el hilo la tome.
    await attendEmailThread(ownerDb, admin, d1.id, true, ago(4 * HOUR))
    // Le respondemos: desde ahí ella está en el hilo, con su primer correo y los que siguen.
    const o1 = await prepareEmailReply(ownerDb, admin, d1.id, { body: "Claro." }, ago(3 * HOUR))
    await markOutreachSent(ownerDb, admin, o1.id, "enviado", ago(3 * HOUR))
    const [o1Row] = await ownerDb.select().from(saasOutreach).where(eq(saasOutreach.id, o1.id))
    const o1Mid = o1Row?.messageId ?? ""
    const chain = `${o0} <d1.dra@clinica-c.test> ${o1Mid}`
    const d2 = await ingestInboundEmail(
      ownerDb,
      mail({
        messageId: "<d2.dra@clinica-c.test>",
        from: "dra@clinica-c.test",
        subject: "Re: Tu prueba de odentIA",
        inReplyTo: o1Mid,
        references: chain,
        receivedAt: ago(2 * HOUR),
      }),
    )
    const thread = await getEmailThread(ownerDb, admin, d2.id, NOW)
    expect(thread.threadKey).toBe(o0)
    expect(thread.entries.map((entry) => entry.id)).toEqual([first?.id, d1.id, o1.id, d2.id])
    expect(await keyOf(d1.id)).toBe(o0)
    // La marca puesta con su clave de antes sigue en el hilo.
    expect(thread.attendedBy).toMatchObject({ id: admin.userId })

    // Un colega en copia que responde no estaba: su propia conversación.
    const colleague = await ingestInboundEmail(
      ownerDb,
      mail({
        messageId: "<cc.otro@clinica-c.test>",
        from: "otro@clinica-c.test",
        inReplyTo: o1Mid,
        references: chain,
        receivedAt: ago(90 * MIN),
      }),
    )
    expect(await keyOf(colleague.id)).toBe("<cc.otro@clinica-c.test>")
    // Un From de la doctora sin verificar puede ser de cualquiera: tampoco entra.
    const unverified = await ingestInboundEmail(
      ownerDb,
      mail({
        messageId: "<sinverificar.dra@clinica-c.test>",
        from: "dra@clinica-c.test",
        inReplyTo: o1Mid,
        references: chain,
        senderVerified: false,
        receivedAt: ago(80 * MIN),
      }),
    )
    expect(await keyOf(unverified.id)).toBe("<sinverificar.dra@clinica-c.test>")
    // Alguien de fuera con las cabeceras copiadas: aparte, hasta que le respondemos.
    const forged = await ingestInboundEmail(
      ownerDb,
      mail({
        messageId: "<falso.c@malo-c.test>",
        from: "x@malo-c.test",
        references: o0,
        receivedAt: ago(70 * MIN),
      }),
    )
    expect(await keyOf(forged.id)).toBe("<falso.c@malo-c.test>")
    expect(
      (await getEmailThread(ownerDb, admin, d2.id, NOW)).entries.map((entry) => entry.id),
    ).not.toContain(forged.id)
    await prepareEmailReply(ownerDb, admin, forged.id, { body: "¿Quién eres?" }, ago(60 * MIN))
    expect(await keyOf(forged.id)).toBe(o0)
  })

  it("la respuesta lista de un correo anterior no cuenta, y responder el hilo cierra todas", async () => {
    const draftFor = async (emailId: string, body: string): Promise<string> => {
      const [row] = await ownerDb
        .insert(kairosItem)
        .values({
          kind: "responder_correo",
          title: "Responder a Rosa Mamani",
          reason: "Le escribió a hola@ de odentIA",
          payload: { emailId, body, draft: { subject: null, body, drafter: "plantilla" } },
          expectedState: {},
          idempotencyKey: `prueba:${crypto.randomUUID()}`,
          expiresAt: later(48 * HOUR),
          adminOnly: true,
        })
        .returning({ id: kairosItem.id })
      return row?.id ?? ""
    }
    const first = await ingestInboundEmail(
      ownerDb,
      mail({
        messageId: "<b1.borrador@nadie.test>",
        from: "dos.borradores@nadie.test",
        subject: "Precios",
        receivedAt: ago(2 * HOUR),
      }),
    )
    const stale = await draftFor(first.id, "Hola, el plan cuesta lo que te conté.")
    const second = await ingestInboundEmail(
      ownerDb,
      mail({
        messageId: "<b2.borrador@nadie.test>",
        from: "dos.borradores@nadie.test",
        subject: "Re: Precios",
        inReplyTo: "<b1.borrador@nadie.test>",
        references: "<b1.borrador@nadie.test>",
        receivedAt: ago(HOUR),
      }),
    )
    // Lo de antes no contesta lo último: te toca sin «Kairós dejó la respuesta lista».
    expect(await listed("correo", second.id, { cliente: "sin" })).toMatchObject({
      state: "te_toca",
      stateWhy: null,
      draftReady: false,
    })
    expect((await getEmailThread(ownerDb, admin, first.id, NOW)).draft).toBeNull()
    const fresh = await draftFor(second.id, "Hola, te respondo lo nuevo.")
    expect((await getEmailThread(ownerDb, admin, first.id, NOW)).draft).toMatchObject({
      itemId: fresh,
      emailId: second.id,
    })
    expect(await listed("correo", second.id, { cliente: "sin" })).toMatchObject({
      stateWhy: "Kairós dejó la respuesta lista",
      draftReady: true,
    })
    // Una persona responde el último: se cierran las dos, también la del correo anterior.
    await prepareEmailReply(ownerDb, admin, second.id, { body: "Te cuento." }, NOW)
    const items = await ownerDb
      .select({ id: kairosItem.id, status: kairosItem.status })
      .from(kairosItem)
      .where(inArray(kairosItem.id, [stale, fresh]))
    expect(items.map((item) => item.status)).toEqual(["vencida", "vencida"])
    // Y el borrador viejo no sale como segunda respuesta aunque se intente aprobar.
    await expect(
      prepareEmailReply(
        ownerDb,
        admin,
        first.id,
        { body: "Hola, el plan cuesta lo que te conté.", kairosItemId: stale },
        NOW,
      ),
    ).rejects.toMatchObject({ code: "ALREADY_REPLIED" })
  })

  it("de cada adjunto guardado dice lo que diría «¿Es la carga de datos?», como el correo", async () => {
    const receivedAt = ago(31 * 24 * HOUR)
    const email = await ingestInboundEmail(
      ownerDb,
      mail({ from: "rosa.venta@bandeja.test", subject: "Mis pacientes", receivedAt }),
    )
    const contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
    const stored = await registerClientFile(ownerDb, null, {
      clientId: sales,
      kind: "correo",
      filename: "pacientes.xlsx",
      objectKey: clientFileKey(sales, "xlsx"),
      contentType,
      sizeBytes: 5,
      deleteAfter: null,
      source: "correo",
      receivedAt,
      inboundEmailId: email.id,
    })
    await ownerDb
      .update(saasInboundEmail)
      .set({
        attachments: [
          { filename: "pacientes.xlsx", contentType, size: 5, fileId: stored.id },
          { filename: "lista.zip", contentType: "application/zip", size: 9, fileId: null },
        ],
      })
      .where(eq(saasInboundEmail.id, email.id))
    const detail = await getInboundEmail(ownerDb, admin, email.id, NOW)
    const thread = await getEmailThread(ownerDb, admin, email.id, NOW)
    expect(detail.files[0]).toMatchObject({ fileId: stored.id, cargaDueNow: true })
    expect(thread.entries[0]).toMatchObject({
      kind: "entro",
      attachments: [
        {
          fileId: stored.id,
          cargaDeleteAfter: detail.files[0]?.cargaDeleteAfter,
          cargaDueNow: true,
        },
        { fileId: null, cargaDeleteAfter: null, cargaDueNow: false },
      ],
    })
  })

  it("sin cliente, sugiere de quién puede ser por su correo exacto, sin ligarlo", async () => {
    // Sin verificar no se liga solo; la sugerencia lo dice.
    const unverified = await ingestInboundEmail(
      ownerDb,
      mail({ from: "rosa.venta@bandeja.test", senderVerified: false }),
    )
    expect(unverified.clientId).toBeNull()
    const thread = await getEmailThread(ownerDb, admin, unverified.id, NOW)
    expect(thread.client).toBeNull()
    expect(thread.suggestion).toMatchObject({
      clientId: sales,
      clientName: "Clínica en venta de la Bandeja (ficticia)",
    })
    expect(thread.suggestion?.why).toContain("no está verificado")
    // Verificado se liga al llegar: tiene cliente, sin sugerencia, con su fase.
    const verified = await ingestInboundEmail(ownerDb, mail({ from: "rosa.venta@bandeja.test" }))
    const linked = await getEmailThread(ownerDb, admin, verified.id, NOW)
    expect(linked.client).toMatchObject({ id: sales, phase: "por_vender", hasApp: false })
    expect(linked.suggestion).toBeNull()
  })
})

describe("el estado de un chat", () => {
  it("Kairós respondió; lo de una persona que no salió te toca; lo incierto, respondida; un aviso no responde", async () => {
    const kairos = await wrote()
    await ownerDb.transaction((tx) =>
      prepareKairosChatReply(tx as Db, kairos.chatId, { body: "¡Hola! Te cuento." }, NOW),
    )
    expect(await chatConversationState(ownerDb, kairos.chatId, NOW)).toMatchObject({
      state: "kairos",
      stateWhy: null,
    })

    const failed = await wrote()
    const no = await prepareChatReply(ownerDb, admin, failed.chatId, { body: "Hola" }, NOW)
    await markChatOutreachFailed(ownerDb, no.outreachId, "rechazado", NOW)
    expect(await chatConversationState(ownerDb, failed.chatId, NOW)).toMatchObject({
      state: "te_toca",
      stateWhy: "No salió tu respuesta",
      // Escribir a mano es atenderla.
      attendedBy: { id: admin.userId, name: "Ada Lovelace" },
    })

    const unsure = await wrote()
    const maybe = await prepareChatReply(ownerDb, admin, unsure.chatId, { body: "Hola" }, NOW)
    await markChatOutreachUncertain(ownerDb, maybe.outreachId, NOW)
    expect(await chatConversationState(ownerDb, unsure.chatId, NOW)).toMatchObject({
      state: "respondida",
      stateWhy: "No se sabe si salió tu respuesta",
    })

    const notice = await wrote()
    await ownerDb.transaction((tx) =>
      prepareKairosChatReply(
        tx as Db,
        notice.chatId,
        { body: "Le recuerdo su presentación", purpose: "aviso", closeItems: false },
        NOW,
      ),
    )
    expect(await chatConversationState(ownerDb, notice.chatId, NOW)).toMatchObject({
      state: "te_toca",
      stateWhy: null,
    })
    // Lo que nunca escribió no está en la Bandeja.
    expect(
      await chatConversationState(ownerDb, "00000000-0000-4000-8000-000000000000", NOW),
    ).toBeNull()
  })

  it("Kairós la pasó al equipo: su aviso no cuenta como respuesta y te toca, con su porqué", async () => {
    const handed = await wrote()
    const fixed = await ownerDb.transaction((tx) =>
      prepareKairosChatReply(
        tx as Db,
        handed.chatId,
        { body: "Te paso con el equipo", closeItems: false },
        NOW,
      ),
    )
    await ownerDb.insert(kairosChatTurn).values({
      chatId: handed.chatId,
      messageId: handed.messageId,
      outcome: "paso",
      why: "Pidió hablar con una persona",
      outreachId: fixed.outreachId,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await ownerDb
      .update(saasChat)
      .set({ kairosPausedAt: NOW, kairosPausedBy: null })
      .where(eq(saasChat.id, handed.chatId))
    expect(await chatConversationState(ownerDb, handed.chatId, NOW)).toMatchObject({
      state: "te_toca",
      stateWhy: "Kairós te la pasó: Pidió hablar con una persona",
      attendedBy: null,
    })
  })

  it("una parte que no llegó deja la respuesta incompleta: te toca, aunque el texto sí llegó", async () => {
    const chat = await wrote()
    await assignChat(ownerDb, admin, chat.chatId, { clientId: sales }, NOW)
    const pdf = await file(sales, "precios-parte.pdf", "application/pdf")
    const reply = await prepareChatReply(
      ownerDb,
      admin,
      chat.chatId,
      { body: "Te mando los precios", fileIds: [pdf.id] },
      NOW,
    )
    await markChatOutreachSent(ownerDb, reply.parts[0]?.outreachId ?? "", "wamid.parte-texto", NOW)
    await markChatOutreachSent(ownerDb, reply.parts[1]?.outreachId ?? "", "wamid.parte-pdf", NOW)
    expect(await chatConversationState(ownerDb, chat.chatId, NOW)).toMatchObject({
      state: "respondida",
    })
    // Meta no pudo descargar el PDF: salió, pero no llegó.
    await applyChatStatus(
      ownerDb,
      { externalId: "wamid.parte-pdf", status: "failed", why: "131053: no se pudo descargar" },
      NOW,
    )
    expect(await chatConversationState(ownerDb, chat.chatId, NOW)).toMatchObject({
      state: "te_toca",
      stateWhy: "No llegó parte de tu respuesta",
    })
  })

  it("lo de Kairós que no llegó pasa al equipo; el aviso con que la pasó, si no llega, sigue diciéndolo", async () => {
    const kairos = await wrote()
    const answer = await ownerDb.transaction((tx) =>
      prepareKairosChatReply(tx as Db, kairos.chatId, { body: "¡Hola! Te cuento." }, NOW),
    )
    await ownerDb.insert(kairosChatTurn).values({
      chatId: kairos.chatId,
      messageId: kairos.messageId,
      outcome: "respondio",
      outreachId: answer.outreachId,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await markChatOutreachSent(ownerDb, answer.outreachId, "wamid.kairos-parte", NOW)
    expect(await chatConversationState(ownerDb, kairos.chatId, NOW)).toMatchObject({
      state: "kairos",
    })
    await applyChatStatus(
      ownerDb,
      { externalId: "wamid.kairos-parte", status: "failed", why: "131026: no es de WhatsApp" },
      NOW,
    )
    // Como lo que no sale: su turno falla con el porqué y la conversación queda con el equipo.
    const [turn] = await ownerDb
      .select()
      .from(kairosChatTurn)
      .where(eq(kairosChatTurn.outreachId, answer.outreachId))
    expect(turn).toMatchObject({
      outcome: "fallo",
      why: "Su respuesta no le llegó (131026: no es de WhatsApp)",
    })
    const [paused] = await ownerDb.select().from(saasChat).where(eq(saasChat.id, kairos.chatId))
    expect(paused?.kairosPausedAt).toBeInstanceOf(Date)
    expect(paused?.kairosPausedBy).toBeNull()
    expect(await chatConversationState(ownerDb, kairos.chatId, NOW)).toMatchObject({
      state: "te_toca",
      stateWhy: "Kairós te la pasó: Su respuesta no le llegó (131026: no es de WhatsApp)",
    })

    // El aviso con que Kairós pasó la conversación no llegó: sigue «Kairós te la pasó».
    const handed = await wrote()
    const notice = await ownerDb.transaction((tx) =>
      prepareKairosChatReply(
        tx as Db,
        handed.chatId,
        { body: "Te paso con el equipo", closeItems: false },
        NOW,
      ),
    )
    await ownerDb.insert(kairosChatTurn).values({
      chatId: handed.chatId,
      messageId: handed.messageId,
      outcome: "paso",
      why: "Pidió hablar con una persona",
      outreachId: notice.outreachId,
      createdAt: NOW,
      updatedAt: NOW,
    })
    await ownerDb
      .update(saasChat)
      .set({ kairosPausedAt: NOW, kairosPausedBy: null })
      .where(eq(saasChat.id, handed.chatId))
    await markChatOutreachSent(ownerDb, notice.outreachId, "wamid.aviso-paso", NOW)
    await applyChatStatus(
      ownerDb,
      { externalId: "wamid.aviso-paso", status: "failed", why: "131047: fuera de las 24 horas" },
      NOW,
    )
    expect(await chatConversationState(ownerDb, handed.chatId, NOW)).toMatchObject({
      state: "te_toca",
      stateWhy: "Kairós te la pasó: Pidió hablar con una persona",
    })
  })

  it("«No necesita respuesta» y «No es una clínica»: respondida, hasta que vuelve a escribir", async () => {
    const address = phone()
    const settled = await wrote({ address })
    const marked = await settleConversation(
      ownerDb,
      admin,
      { kind: "chat", id: settled.chatId },
      NOW,
    )
    expect(marked).toMatchObject({
      kind: "chat",
      settledAt: NOW,
      settledBy: { id: admin.userId, name: "Ada Lovelace" },
    })
    expect(await chatConversationState(ownerDb, settled.chatId, NOW)).toMatchObject({
      state: "respondida",
      stateWhy: "No necesitaba respuesta",
      settledAt: NOW,
    })
    expect(await audits("arm.inbox_settled", settled.chatId)).toHaveLength(1)
    // Escribe otra vez: lo de antes ya no esperaba, esto sí.
    const after = later(5 * MIN)
    await wrote({ address, body: "Una pregunta más", receivedAt: after }, after)
    expect(await chatConversationState(ownerDb, settled.chatId, after)).toMatchObject({
      state: "te_toca",
    })
    await unsettleConversation(ownerDb, admin, { kind: "chat", id: settled.chatId }, after)
    expect((await chatConversationState(ownerDb, settled.chatId, after))?.settledAt).toBeNull()
    expect(await audits("arm.inbox_unsettled", settled.chatId)).toHaveLength(1)
    // Deshacer otra vez no cambia nada ni se audita dos veces.
    await unsettleConversation(ownerDb, admin, { kind: "chat", id: settled.chatId }, after)
    expect(await audits("arm.inbox_unsettled", settled.chatId)).toHaveLength(1)

    const notClinic = await wrote()
    await markChatNotClinic(ownerDb, admin, notClinic.chatId, NOW)
    expect(await chatConversationState(ownerDb, notClinic.chatId, NOW)).toMatchObject({
      state: "respondida",
      stateWhy: "No es una clínica",
    })
  })
})

describe("la lista", () => {
  it("primero lo que te toca (lo que espera hace más, arriba), después lo último que pasó; los números son de todo", async () => {
    const before = await listInbox(ownerDb, admin, { limit: 1 }, later(10 * MIN))
    const orderClient = await client("Clínica del orden de la Bandeja (ficticia)")
    await ownerDb.insert(saasClientContact).values({
      clientId: orderClient,
      name: "Olga Orden",
      email: "olga.orden@bandeja.test",
      isPrimary: true,
    })
    const linked = async (receivedAt: Date) => {
      const chat = await wrote({ receivedAt })
      await assignChat(ownerDb, admin, chat.chatId, { clientId: orderClient }, NOW)
      return chat.chatId
    }
    const oldest = await linked(ago(3 * HOUR))
    const email = await ingestInboundEmail(
      ownerDb,
      mail({ from: "olga.orden@bandeja.test", receivedAt: ago(2 * HOUR) }),
    )
    expect(email.clientId).toBe(orderClient)
    const answered = await linked(ago(4 * HOUR))
    await prepareChatReply(ownerDb, admin, answered, { body: "Listo" }, later(MIN))
    const byKairos = await linked(ago(5 * HOUR))
    await ownerDb.transaction((tx) =>
      prepareKairosChatReply(tx as Db, byKairos, { body: "Te cuento" }, later(2 * MIN)),
    )
    // Uno más sin cliente, para «sin cliente».
    await wrote()

    const at = later(10 * MIN)
    const { items, counts } = await listInbox(ownerDb, admin, { cliente: orderClient }, at)
    expect(items.map((item) => [item.kind, item.id, item.state])).toEqual([
      ["chat", oldest, "te_toca"],
      ["correo", email.id, "te_toca"],
      ["chat", byKairos, "kairos"],
      ["chat", answered, "respondida"],
    ])
    expect(items[0]?.client).toMatchObject({
      id: orderClient,
      phase: "por_vender",
      hasApp: false,
      product: "dental",
    })
    expect(counts.teToca).toBe(before.counts.teToca + 3)
    expect(counts.kairos).toBe(before.counts.kairos + 1)
    expect(counts.sinCliente).toBe(before.counts.sinCliente + 1)
    expect(await inboxCounts(ownerDb, admin, at)).toEqual({ teToca: counts.teToca })

    // Los filtros: estado, cliente, fase, canal y el tope.
    const only = async (filter: Parameters<typeof listInbox>[2]) =>
      (await listInbox(ownerDb, admin, { cliente: orderClient, ...filter }, at)).items.map(
        (item) => item.id,
      )
    expect(await only({ estado: "te_toca" })).toEqual([oldest, email.id])
    expect(await only({ estado: "kairos" })).toEqual([byKairos])
    expect(await only({ estado: "respondida" })).toEqual([answered])
    expect(await only({ canal: "correo" })).toEqual([email.id])
    expect(await only({ fase: "por_vender" })).toHaveLength(4)
    expect(await only({ fase: "activo" })).toEqual([])
    expect(await only({ limit: 1 })).toEqual([oldest])
    const sin = await listInbox(ownerDb, admin, { cliente: "sin", limit: 100 }, at)
    expect(sin.items.every((item) => item.client === null)).toBe(true)
    // Sin cliente está «por vender».
    const unowned = await listInbox(
      ownerDb,
      admin,
      { cliente: "sin", fase: "por_vender", limit: 100 },
      at,
    )
    expect(unowned.items.length).toBe(sin.items.length)
    await expect(
      listInbox(ownerDb, admin, { estado: "otro" as "te_toca" }, at),
    ).rejects.toMatchObject({ code: "VALIDATION", fields: { estado: expect.any(String) } })
    await expect(listInbox(ownerDb, admin, { cliente: "x" }, at)).rejects.toMatchObject({
      fields: { cliente: expect.any(String) },
    })
  })

  it("de quién es un hilo lo dicen todos sus correos, también los de antes de la ventana", async () => {
    // El primer correo, ligado a su cliente, llegó hace 200 días: fuera de la ventana de la lista.
    const old = await ingestInboundEmail(
      ownerDb,
      mail({
        messageId: "<viejo.ventana@clinica.test>",
        from: "rosa.venta@bandeja.test",
        subject: "Hace mucho",
        receivedAt: ago(200 * 24 * HOUR),
      }),
    )
    expect(old.clientId).toBe(sales)
    const before = await listInbox(ownerDb, admin, { limit: 1 }, NOW)
    const recent = await ingestInboundEmail(
      ownerDb,
      mail({
        messageId: "<nuevo.ventana@clinica.test>",
        from: "rosa.venta@bandeja.test",
        subject: "Re: Hace mucho",
        inReplyTo: "<viejo.ventana@clinica.test>",
        references: "<viejo.ventana@clinica.test>",
        receivedAt: ago(HOUR),
      }),
    )
    // El nuevo, sin cliente: el hilo sigue siendo de quien es su correo de antes.
    await ownerDb
      .update(saasInboundEmail)
      .set({ clientId: null })
      .where(eq(saasInboundEmail.id, recent.id))
    expect(await listed("correo", recent.id, { cliente: "sin" })).toBeUndefined()
    expect(await listed("correo", recent.id, { estado: "te_toca", canal: "correo" })).toMatchObject(
      { client: { id: sales } },
    )
    const after = await listInbox(ownerDb, admin, { limit: 1 }, NOW)
    expect(after.counts.teToca).toBe(before.counts.teToca + 1)
    expect(after.counts.sinCliente).toBe(before.counts.sinCliente)
  })

  it("Soporte no ve la Bandeja: 403 en todo", async () => {
    const email = await ingestInboundEmail(ownerDb, mail({ from: "soporte.no@nadie.test" }))
    const chat = await wrote()
    for (const attempt of [
      () => listInbox(ownerDb, support, {}, NOW),
      () => inboxCounts(ownerDb, support, NOW),
      () => getEmailThread(ownerDb, support, email.id, NOW),
      () => attendEmailThread(ownerDb, support, email.id, true, NOW),
      () => settleConversation(ownerDb, support, { kind: "chat", id: chat.chatId }, NOW),
      () => unsettleConversation(ownerDb, support, { kind: "correo", id: email.id }, NOW),
      () => getChat(ownerDb, support, chat.chatId, NOW),
    ])
      await expect(attempt()).rejects.toMatchObject({ code: "FORBIDDEN", status: 403 })
  })
})

describe("las marcas en un correo", () => {
  it("«Lo atiendo yo»: queda quien lo tomó primero; cualquiera lo suelta; se audita lo que cambió", async () => {
    const email = await ingestInboundEmail(ownerDb, mail({ from: "atiende@nadie.test" }))
    const first = await attendEmailThread(ownerDb, admin, email.id, true, NOW)
    expect(first).toMatchObject({
      attendedBy: { id: admin.userId, name: "Ada Lovelace" },
      attendedAt: NOW,
    })
    const second = await attendEmailThread(ownerDb, other, email.id, true, later(MIN))
    expect(second.attendedBy?.id).toBe(admin.userId)
    expect((await listed("correo", email.id, { cliente: "sin" }))?.attendedBy).toEqual({
      id: admin.userId,
      name: "Ada Lovelace",
    })
    const released = await attendEmailThread(ownerDb, other, email.id, false, later(2 * MIN))
    expect(released).toMatchObject({ attendedBy: null, attendedAt: null })
    expect((await getEmailThread(ownerDb, admin, email.id, NOW)).attendedBy).toBeNull()
    const trail = await audits("arm.inbox_attended", email.id)
    expect(trail.map((row) => [row.actorUserId, (row.metadata as { on: boolean }).on])).toEqual([
      [admin.userId, true],
      [other.userId, false],
    ])
  })

  it("«No necesita respuesta» en un hilo: respondida hasta que llega otro correo del hilo", async () => {
    const first = await ingestInboundEmail(
      ownerDb,
      mail({ from: "gracias@nadie.test", messageId: "<gracias.1@clinica.test>" }),
    )
    await settleConversation(ownerDb, admin, { kind: "correo", id: first.id }, NOW)
    expect(await getEmailThread(ownerDb, admin, first.id, NOW)).toMatchObject({
      state: "respondida",
      stateWhy: "No necesitaba respuesta",
      settledAt: NOW,
    })
    const again = await ingestInboundEmail(
      ownerDb,
      mail({
        from: "gracias@nadie.test",
        messageId: "<gracias.2@clinica.test>",
        references: "<gracias.1@clinica.test>",
        receivedAt: later(MIN),
      }),
    )
    const thread = await getEmailThread(ownerDb, admin, first.id, later(2 * MIN))
    expect(thread).toMatchObject({ emailId: again.id, state: "te_toca" })
    expect(await audits("arm.inbox_settled", first.id)).toHaveLength(1)
  })

  it("si después llega el correo que respondía, la clave del hilo cambia y sus marcas siguen", async () => {
    const child = await ingestInboundEmail(
      ownerDb,
      mail({
        messageId: "<hijo.marca@nadie.test>",
        from: "marca@nadie.test",
        subject: "Re: Demo",
        inReplyTo: "<padre.marca@nadie.test>",
        receivedAt: ago(HOUR),
      }),
    )
    expect((await getEmailThread(ownerDb, admin, child.id, NOW)).threadKey).toBe(
      "<padre.marca@nadie.test>",
    )
    await settleConversation(ownerDb, admin, { kind: "correo", id: child.id }, ago(50 * MIN))
    await attendEmailThread(ownerDb, admin, child.id, true, ago(50 * MIN))
    // Llega el padre (escrito antes, guardado después), que viene de un hilo más largo.
    const parent = await ingestInboundEmail(
      ownerDb,
      mail({
        messageId: "<padre.marca@nadie.test>",
        from: "marca@nadie.test",
        subject: "Demo",
        inReplyTo: "<raiz.marca@nadie.test>",
        references: "<raiz.marca@nadie.test>",
        receivedAt: ago(2 * HOUR),
      }),
    )
    const thread = await getEmailThread(ownerDb, admin, child.id, NOW)
    expect(thread.threadKey).toBe("<raiz.marca@nadie.test>")
    expect(thread.entries.map((entry) => entry.id)).toEqual([parent.id, child.id])
    expect(thread).toMatchObject({
      state: "respondida",
      stateWhy: "No necesitaba respuesta",
      attendedBy: { id: admin.userId, name: "Ada Lovelace" },
    })
    expect(await listed("correo", child.id, { cliente: "sin" })).toMatchObject({
      state: "respondida",
      attendedBy: { id: admin.userId },
    })
    // Sigue quien lo tomó primero; soltarlo y deshacerlo tocan la marca de antes.
    expect((await attendEmailThread(ownerDb, other, parent.id, true, NOW)).attendedBy?.id).toBe(
      admin.userId,
    )
    await unsettleConversation(ownerDb, admin, { kind: "correo", id: parent.id }, NOW)
    await attendEmailThread(ownerDb, admin, parent.id, false, NOW)
    expect(await getEmailThread(ownerDb, admin, child.id, NOW)).toMatchObject({
      state: "te_toca",
      attendedBy: null,
    })
  })
})

describe("responder un chat con archivos", () => {
  it("el texto con el formato del canal y un envío por archivo, en orden; salen firmados por una hora", async () => {
    const chat = await wrote()
    await assignChat(ownerDb, admin, chat.chatId, { clientId: sales }, NOW)
    const pdf = await file(sales, "propuesta.pdf", "application/pdf")
    const png = await file(sales, "logo.png", "image/png")
    const reply = await prepareChatReply(
      ownerDb,
      admin,
      chat.chatId,
      {
        body: "Te mando **la propuesta** y el [detalle](https://odentia32.com/precios)",
        fileIds: [pdf.id, png.id],
      },
      NOW,
    )
    expect(reply.parts.map((part) => [part.kind, part.filename, part.fileId])).toEqual([
      ["texto", null, null],
      ["archivo", "propuesta.pdf", pdf.id],
      ["archivo", "logo.png", png.id],
    ])
    expect(reply.body).toBe(
      "Te mando *la propuesta* y el detalle: https://odentia32.com/precios\n\n— Ada · odentIA",
    )
    const rows = await outreachOfChat(chat.chatId)
    expect(rows.map((row) => [row.body, row.fileIds, row.status])).toEqual([
      [reply.body, [], "pendiente"],
      ["propuesta.pdf", [pdf.id], "pendiente"],
      ["logo.png", [png.id], "pendiente"],
    ])
    const signed: Array<[string, number | undefined]> = []
    const storage = {
      async attachmentUrl(key: string, ttl?: number) {
        signed.push([key, ttl])
        return `https://r2.test/${key}?firma`
      },
    }
    const outbound = await ownerDb.transaction((tx) => chatReplyOutbound(tx as Db, storage, reply))
    expect(outbound.map((part) => part.media?.mimeType ?? null)).toEqual([
      null,
      "application/pdf",
      "image/png",
    ])
    expect(outbound[1]?.media).toMatchObject({
      filename: "propuesta.pdf",
      url: `https://r2.test/${pdf.objectKey}?firma`,
    })
    expect(signed.map(([, ttl]) => ttl)).toEqual([3600, 3600])
    // Firmar no es mandar: la constancia de cada archivo queda cuando de verdad sale.
    expect(await audits("client_file.sent", pdf.id)).toHaveLength(0)
    // Sale el texto y el PDF; el logo no se envía si lo anterior no salió: queda no salió.
    await markChatOutreachSent(ownerDb, reply.parts[0]?.outreachId ?? "", "wamid.texto", NOW)
    await markChatOutreachSent(ownerDb, reply.parts[1]?.outreachId ?? "", "wamid.pdf", NOW)
    const skipped = await skipChatOutreach(
      ownerDb,
      [reply.parts[2]?.outreachId ?? ""],
      "No se envió: prueba",
      NOW,
    )
    expect([...skipped.values()]).toEqual(["no_salio"])
    const sentPdf = await audits("client_file.sent", pdf.id)
    expect(sentPdf).toHaveLength(1)
    expect(sentPdf[0]).toMatchObject({
      actorUserId: admin.userId,
      actorRole: "admin",
      metadata: expect.objectContaining({
        clientId: sales,
        chatId: chat.chatId,
        channel: "whatsapp",
        outreachId: reply.parts[1]?.outreachId,
      }),
    })
    // Lo que no salió no se dio a Meta: sin constancia.
    expect(await audits("client_file.sent", png.id)).toHaveLength(0)
    // Cada archivo que salió deja su actividad con su nombre.
    const bodies = (
      await ownerDb.select().from(saasFollowUp).where(eq(saasFollowUp.chatId, chat.chatId))
    ).map((row) => row.body)
    expect(bodies).toContain("Le mandamos «propuesta.pdf»")
    expect(bodies).not.toContain("Le mandamos «logo.png»")
    // Solo archivos, sin texto: también vale.
    const filesOnly = await prepareChatReply(
      ownerDb,
      admin,
      chat.chatId,
      { fileIds: [pdf.id] },
      later(MIN),
    )
    expect(filesOnly.parts.map((part) => part.kind)).toEqual(["archivo"])
  })

  it("sin cliente, 409; un archivo ajeno o borrado, 400; lo que el canal no acepta, con su nombre", async () => {
    const lonely = await wrote()
    const ours = await file(sales, "contrato.pdf", "application/pdf")
    await expect(
      prepareChatReply(ownerDb, admin, lonely.chatId, { fileIds: [ours.id] }, NOW),
    ).rejects.toMatchObject({
      code: "CHAT_FILES_NEED_CLIENT",
      status: 409,
      message: "Liga la conversación a un cliente para mandar archivos",
      fields: { fileIds: expect.any(String) },
    })
    const chat = await wrote()
    await assignChat(ownerDb, admin, chat.chatId, { clientId: sales }, NOW)
    const theirs = await file(stranger, "ajeno.pdf", "application/pdf")
    await expect(
      prepareChatReply(ownerDb, admin, chat.chatId, { fileIds: [theirs.id] }, NOW),
    ).rejects.toMatchObject({ code: "VALIDATION", fields: { fileIds: expect.any(String) } })
    const gone = await file(sales, "borrado.pdf", "application/pdf")
    await deleteClientFile(ownerDb, admin, gone.id, NOW)
    await expect(
      prepareChatReply(ownerDb, admin, chat.chatId, { fileIds: [gone.id] }, NOW),
    ).rejects.toMatchObject({ code: "VALIDATION", fields: { fileIds: expect.any(String) } })
    // Lo que mandó la clínica para la carga no sale por chat: se borra a los 30 días.
    const carga = await registerClientFile(ownerDb, admin, {
      clientId: sales,
      kind: "archivo_clinica",
      filename: "pacientes.pdf",
      objectKey: clientFileKey(sales, "pdf"),
      contentType: "application/pdf",
      sizeBytes: MB,
      adminOnly: true,
    })
    const cargaWords =
      "Lo que mandó la clínica para la carga no sale por chat: se borra a los 30 días"
    await expect(
      prepareChatReply(
        ownerDb,
        admin,
        chat.chatId,
        { body: "Va", fileIds: [ours.id, carga.id] },
        NOW,
      ),
    ).rejects.toMatchObject({
      code: "VALIDATION",
      status: 400,
      message: cargaWords,
      fields: { fileIds: cargaWords, "fileIds[1]": cargaWords },
    })
    const big = await file(sales, "foto.png", "image/png", 6 * MB)
    const gif = await file(sales, "animado.gif", "image/gif")
    const failure = await prepareChatReply(
      ownerDb,
      admin,
      chat.chatId,
      { body: "Van", fileIds: [ours.id, big.id, gif.id] },
      NOW,
    ).catch((error: unknown) => error)
    expect(failure).toMatchObject({
      code: "VALIDATION",
      status: 400,
      fields: {
        "fileIds[1]": "«foto.png» pesa 6 MB y WhatsApp manda imágenes de hasta 5 MB",
        "fileIds[2]": expect.stringContaining("«animado.gif» no sale por WhatsApp"),
        fileIds: expect.stringContaining("«foto.png»"),
      },
    })
    // Nada quedó reservado.
    expect(await outreachOfChat(chat.chatId)).toHaveLength(0)
    // Instagram: un Excel no sale.
    const ig = await wrote({
      channel: "instagram",
      address: `ig-${crypto.randomUUID().slice(0, 8)}`,
    })
    await assignChat(ownerDb, admin, ig.chatId, { clientId: sales }, NOW)
    const xlsx = await file(
      sales,
      "pacientes.xlsx",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )
    await expect(
      prepareChatReply(ownerDb, admin, ig.chatId, { fileIds: [xlsx.id] }, NOW),
    ).rejects.toMatchObject({
      fields: { "fileIds[0]": expect.stringContaining("«pacientes.xlsx» no sale por Instagram") },
    })
  })

  it("fuera de las 24 h no salen archivos; con la plantilla no van; sin texto ni archivos, falta el mensaje", async () => {
    const old = await wrote({ receivedAt: ago(25 * HOUR) })
    await assignChat(ownerDb, admin, old.chatId, { clientId: sales }, NOW)
    const pdf = await file(sales, "tarde.pdf", "application/pdf")
    await expect(
      prepareChatReply(ownerDb, admin, old.chatId, { fileIds: [pdf.id] }, NOW),
    ).rejects.toMatchObject({ code: "CHAT_WINDOW_CLOSED", status: 409 })
    await expect(
      prepareChatReply(
        ownerDb,
        admin,
        old.chatId,
        { template: "retomar_conversacion", fileIds: [pdf.id] },
        NOW,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION", fields: { fileIds: expect.any(String) } })
    const fresh = await wrote()
    await expect(
      prepareChatReply(ownerDb, admin, fresh.chatId, { body: "  " }, NOW),
    ).rejects.toMatchObject({ fields: { body: "Escribe el mensaje" } })
  })

  it("cada canal con su tope de texto, firma incluida: Messenger 2000 caracteres, Instagram 1000 bytes", async () => {
    const messenger = await wrote({
      channel: "messenger",
      address: `psid-${crypto.randomUUID().slice(0, 8)}`,
    })
    await expect(
      prepareChatReply(ownerDb, admin, messenger.chatId, { body: "a".repeat(1990) }, NOW),
    ).rejects.toMatchObject({ fields: { body: expect.stringContaining("2000 caracteres") } })
    const ok = await prepareChatReply(
      ownerDb,
      admin,
      messenger.chatId,
      { body: "Hola *Lucía*, ~listo~" },
      NOW,
    )
    // Messenger no tiene formato: sale sin marcas.
    expect(ok.body).toBe("Hola Lucía, listo\n\n— Ada · odentIA")
    const instagram = await wrote({
      channel: "instagram",
      address: `igsid-${crypto.randomUUID().slice(0, 8)}`,
    })
    await expect(
      prepareChatReply(ownerDb, admin, instagram.chatId, { body: "á".repeat(495) }, NOW),
    ).rejects.toMatchObject({ fields: { body: expect.stringContaining("1000 bytes") } })
  })
})

describe("lo que dice el chat de lo que salió", () => {
  it("entregado y leído de WhatsApp, en qué se basó Kairós, el archivo de cada envío, su estado y sus reglas", async () => {
    const chat = await wrote()
    await assignChat(ownerDb, admin, chat.chatId, { clientId: clinic }, NOW)
    const pdf = await file(clinic, "guia.pdf", "application/pdf")
    const reply = await prepareChatReply(
      ownerDb,
      admin,
      chat.chatId,
      { body: "Te mando la guía", fileIds: [pdf.id] },
      NOW,
    )
    const [text, attached] = reply.parts
    await markChatOutreachSent(ownerDb, text?.outreachId ?? "", "wamid.guia-texto", NOW)
    await markChatOutreachSent(ownerDb, attached?.outreachId ?? "", "wamid.guia-pdf", NOW)
    expect(
      await applyChatStatus(ownerDb, { externalId: "wamid.guia-texto", status: "delivered" }, NOW),
    ).toMatchObject({ status: "enviado", changed: true })
    expect(
      await applyChatStatus(
        ownerDb,
        { externalId: "wamid.guia-texto", status: "read" },
        later(MIN),
      ),
    ).toMatchObject({ changed: true })
    // Un «delivered» tardío no vuelve atrás lo que ya se anotó.
    expect(
      await applyChatStatus(
        ownerDb,
        { externalId: "wamid.guia-texto", status: "delivered" },
        later(2 * MIN),
      ),
    ).toMatchObject({ changed: false })
    const kairosChat = await wrote()
    const kairosReply = await ownerDb.transaction((tx) =>
      prepareKairosChatReply(
        tx as Db,
        kairosChat.chatId,
        { body: "Los planes están en la web" },
        NOW,
      ),
    )
    await ownerDb.insert(kairosChatTurn).values({
      chatId: kairosChat.chatId,
      messageId: kairosChat.messageId,
      outcome: "respondio",
      outreachId: kairosReply.outreachId,
      basis: ["los precios de la web"],
      createdAt: NOW,
      updatedAt: NOW,
    })

    const view = await getChat(ownerDb, admin, chat.chatId, later(3 * MIN))
    const sent = view.entries.filter((entry) => entry.kind === "salio")
    expect(sent.map((entry) => [entry.id, entry.body])).toEqual([
      [text?.outreachId, "Te mando la guía\n\n— Ada · odentIA"],
      [attached?.outreachId, "guia.pdf"],
    ])
    expect(sent[0]).toMatchObject({ deliveredAt: NOW, readAt: later(MIN), basis: [], files: [] })
    expect(sent[1]).toMatchObject({
      deliveredAt: null,
      readAt: null,
      files: [{ id: pdf.id, filename: "guia.pdf", contentType: "application/pdf", size: MB }],
    })
    expect(view).toMatchObject({
      rules: { channel: "whatsapp", maxChars: 4096, maxFiles: 5, formatting: "whatsapp" },
      client: { id: clinic, hasAccount: true, phase: "en_alta" },
      state: "respondida",
      stateWhy: null,
      attendedBy: { id: admin.userId, name: "Ada Lovelace" },
      settledAt: null,
    })
    const kairosView = await getChat(ownerDb, admin, kairosChat.chatId, NOW)
    expect(kairosView.state).toBe("kairos")
    expect(kairosView.entries.find((entry) => entry.kind === "salio")).toMatchObject({
      byKairos: true,
      basis: ["los precios de la web"],
    })
  })
})

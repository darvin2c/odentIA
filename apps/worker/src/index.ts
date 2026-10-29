import { type AgentRuntime, consumeAgentRun, createAlreadyTold, decisionKeyStartProblem, embedderFromEnv, platformLlmFromEnv } from "@odentia/agent"
import { emailVerificationUrl, REMINDER_VERIFICATION_TTL_SECONDS } from "@odentia/auth"
import { configureMetaGraphVersion } from "@odentia/channels"
import type { AgentRunJob, InboundMessageJob, OutboundMessageJob, QueueMessage } from "@odentia/db"
import { createAppDb, createOwnerDb, type Db } from "@odentia/db"
import { configureMailLinks, createMailer } from "@odentia/mail"
import { configurePublicLinks, createStorage, type Storage, secretsKeyFromEnv } from "@odentia/services"
import { sql } from "drizzle-orm"
import { env } from "./env.js"
import { type DemoTaskMessage, processDemoTask } from "./handler.js"
import { consumeInbound } from "./inbound.js"
import { consumeOutbound } from "./outbound.js"
import { createTranscriber } from "./transcribe.js"
import { runAutomationTick } from "./automation.js"
import { runLegalNoticesTick } from "./legal-notices.js"
import { tickMailboxes } from "./mailboxes.js"
import { runDemosTick } from "./demos.js"
import { runSaasBillingTick } from "./saas-billing.js"
import { runSupportNoticesTick } from "./support-notices.js"
import { runAccountLifecycleTick } from "./account-lifecycle.js"
import { runContactScreensTick } from "./contact-screens.js"
import { runReportDigestTick } from "./report-digests.js"
import { runOwnAppTokenTick, runSignupTokenTick } from "./whatsapp-tokens.js"
import { runBackupWatchTick } from "./backup-watch.js"

const db: Db = createAppDb(env.APP_DATABASE_URL)
const ownerDb = createOwnerDb(env.DATABASE_URL)
const secretsKey = secretsKeyFromEnv(env.SECRETS_KEY)
// «Su enlace» va en el aviso de la cita y en las plantillas de WhatsApp: con la dirección pública de cada clínica.
// Cada clínica en el dominio de su producto (decisión 9 del issue 229).
const publicLinks = {
  webURL: env.WEB_URL,
  cookieDomain: env.COOKIE_DOMAIN,
  productDomains: env.MEDICAL_DOMAIN ? { medical: env.MEDICAL_DOMAIN } : {},
}
configurePublicLinks(publicLinks)
// La misma versión del Graph de Meta que la API (`META_GRAPH_VERSION`).
configureMetaGraphVersion(env.META_GRAPH_VERSION)
// Términos, Privacidad y Ayuda del pie de cada correo.
// El pie de cada correo lleva la web de su marca: la de latidIA, en su dominio (issue 229).
configureMailLinks(env.WEB_URL, { latidia: env.MEDICAL_DOMAIN })
const mailer = createMailer({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  user: env.SMTP_USER || undefined,
  pass: env.SMTP_PASS || undefined,
  from: env.SMTP_FROM,
  fromByBrand: env.MEDICAL_SMTP_FROM ? { latidia: env.MEDICAL_SMTP_FROM } : {},
})
const storage: Storage = createStorage({
  endpoint: env.S3_ENDPOINT,
  region: env.S3_REGION,
  accessKeyId: env.S3_ACCESS_KEY,
  secretAccessKey: env.S3_SECRET_KEY,
  avatarsBucket: env.S3_BUCKET,
  publicBaseUrl: env.S3_PUBLIC_URL,
  attachmentsBucket: env.S3_ATTACHMENTS_BUCKET,
})

const transcribe = createTranscriber(env)

const embedder = embedderFromEnv(env)
// Sin la clave de Jev el agente sigue, pero lo ajeno se cobra: que se vea en el registro (ADR 0047).
const decisionKeyProblem = decisionKeyStartProblem(env)
if (decisionKeyProblem) console.error(`worker: ${decisionKeyProblem}`)
const agentRuntime: AgentRuntime = {
  // Un modelo que no responde abre el caso automático en Soporte de odentIA.
  ownerDb,
  publicUrl: publicLinks,
  // Reenviar un presupuesto lleva su PDF.
  storage,
  ...(embedder ? { embedder } : {}),
  ...(env.AGENT_BURST_WINDOW_SECONDS > 0
    ? {
        burst: {
          quietMs: env.AGENT_BURST_WINDOW_SECONDS * 1000,
          maxWaitMs: Math.max(env.AGENT_BURST_WINDOW_SECONDS, env.AGENT_BURST_MAX_WAIT_SECONDS) * 1000,
        },
      }
    : {}),
  platform: platformLlmFromEnv(env),
  decisions: {
    ...(env.JEV_API_KEY ? { jev: { apiKey: env.JEV_API_KEY, baseUrl: env.JEV_BASE_URL, model: env.JEV_MODEL } } : {}),
    timeoutMs: env.DECISIONS_TIMEOUT_MS,
  },
  secretsKey,
}

const VT_SECONDS = 30
const BATCH = 1

let stopping = false
process.on("SIGINT", () => (stopping = true))
process.on("SIGTERM", () => (stopping = true))

async function readOne<T>(queue: string): Promise<QueueMessage<T> | null> {
  const rows = (await db.execute(
    sql`select msg_id, read_ct, message from pgmq.read(${queue}, ${VT_SECONDS}, ${BATCH})`,
  )) as unknown as { msg_id: number; read_ct: number; message: T }[]
  const first = rows[0]
  return first
    ? { msg_id: Number(first.msg_id), read_ct: Number(first.read_ct), message: first.message }
    : null
}

async function ack(queue: string, msgId: number): Promise<void> {
  await db.execute(sql`select pgmq.delete(${queue}, ${msgId}::bigint)`)
}

interface QueueDef {
  name: string
  poll: () => Promise<boolean>
}

const queues: QueueDef[] = [
  {
    name: "demo_tasks",
    poll: async () => {
      const msg = await readOne<DemoTaskMessage["message"]>("demo_tasks")
      if (!msg) return false
      await processDemoTask(db, { msg_id: msg.msg_id, message: msg.message })
      await ack("demo_tasks", msg.msg_id)
      console.log(`worker: demo_task.done msg_id=${msg.msg_id}`)
      return true
    },
  },
  {
    name: "inbound_messages",
    poll: async () => {
      const msg = await readOne<InboundMessageJob>("inbound_messages")
      if (!msg) return false
      await consumeInbound(
        db,
        {
          storage,
          fetch,
          secretsKey,
          transcribe: transcribe ?? undefined,
          agentBurstWindowSeconds: env.AGENT_BURST_WINDOW_SECONDS,
        },
        msg,
      )
      console.log(`worker: inbound msg_id=${msg.msg_id}`)
      return true
    },
  },
  {
    name: "outbound_messages",
    poll: async () => {
      const msg = await readOne<OutboundMessageJob>("outbound_messages")
      if (!msg) return false
      await consumeOutbound(
        db,
        { storage, fetch, secretsKey, senderMode: env.CHANNEL_SENDER_MODE },
        msg,
      )
      console.log(`worker: outbound msg_id=${msg.msg_id}`)
      return true
    },
  },
  {
    name: "agent_runs",
    poll: async () => {
      const msg = await readOne<AgentRunJob>("agent_runs")
      if (!msg) return false
      await consumeAgentRun(db, agentRuntime, msg)
      console.log(`worker: agent msg_id=${msg.msg_id}`)
      return true
    },
  },
  {
    name: "automation_ticks",
    poll: () =>
      runAutomationTick({
        appDb: db,
        ownerDb,
        secretsKey,
        publicBaseUrl: env.WEB_URL,
        storage,
        senderMode: env.CHANNEL_SENDER_MODE,
        alreadyTold: createAlreadyTold(db, { secretsKey, platform: agentRuntime.platform, decisions: agentRuntime.decisions }),
        embedder,
      }),
  },
]
let nextMailboxPoll = 0
queues.push({
  name: "mailboxes",
  poll: async () => {
    if (Date.now() < nextMailboxPoll) return false
    nextMailboxPoll = Date.now() + env.MAILBOX_POLL_INTERVAL_MS
    const result = await tickMailboxes({
      db, ownerDb, secretsKey, fetch,
      gmail: { clientId: env.GMAIL_CLIENT_ID, clientSecret: env.GMAIL_CLIENT_SECRET, redirectUri: env.GMAIL_REDIRECT_URI },
      microsoft365: { clientId: env.MICROSOFT_MAIL_CLIENT_ID, clientSecret: env.MICROSOFT_MAIL_CLIENT_SECRET, redirectUri: env.MICROSOFT_MAIL_REDIRECT_URI, tenant: env.MICROSOFT_MAIL_TENANT },
    })
    return result.ingested > 0
  },
})

let nextSaasPoll = 0
let nextScreensPoll = 0
let nextAccountPoll = 0
let nextSupportPoll = 0
let nextLegalPoll = 0
let nextDigestPoll = 0
let nextDemoPoll = 0
queues.push({
  name: "saas_billing",
  poll: async () => {
    if (Date.now() < nextSaasPoll) return false
    nextSaasPoll = Date.now() + 60_000
    await runSaasBillingTick({ ownerDb, mailer, panelUrl: env.WEB_URL })
    return true
  },
}, {
  // Spam y bloqueados (ADR 0054): el bloqueo en WhatsApp y borrar el spam viejo.
  name: "contact_screens",
  poll: async () => {
    if (Date.now() < nextScreensPoll) return false
    nextScreensPoll = Date.now() + 60_000
    const result = await runContactScreensTick({
      appDb: db, ownerDb, storage, fetch, secretsKey, senderMode: env.CHANNEL_SENDER_MODE,
    })
    return result.blocks > 0 || result.redacted > 0
  },
}, {
  // Avisos por correo de los casos de soporte: a soporte y a quien preguntó.
  name: "support_notices",
  poll: async () => {
    if (Date.now() < nextSupportPoll) return false
    nextSupportPoll = Date.now() + 60_000
    const result = await runSupportNoticesTick({
      ownerDb,
      mailer,
      supportInbox: env.SUPPORT_INBOX_EMAIL,
      adminUrl: env.ADMIN_URL,
      webUrl: env.WEB_URL,
    })
    return result.mailed > 0
  },
}, {
  // Aviso por correo de términos nuevos, antes de que rijan.
  name: "legal_notices",
  poll: async () => {
    if (Date.now() < nextLegalPoll) return false
    nextLegalPoll = Date.now() + 3_600_000
    const result = await runLegalNoticesTick({
      ownerDb,
      mailer,
      webUrl: env.WEB_URL,
      // Quien no está de acuerdo responde al correo: llega a soporte.
      replyTo: env.SUPPORT_INBOX_EMAIL || undefined,
    })
    return result.mailed > 0
  },
}, {
  // El resumen del lunes de Reportes: a quien lo prendió, el lunes desde las 8:00 de su clínica.
  name: "report_digests",
  poll: async () => {
    if (Date.now() < nextDigestPoll) return false
    nextDigestPoll = Date.now() + 60_000
    const result = await runReportDigestTick({ ownerDb, appDb: db, mailer, secretsKey })
    return result.mailed > 0
  },
}, {
  // Las demos para presentar (ADR 0096): se arman aparte, y cada día de su zona se ponen al día.
  name: "demos",
  poll: async () => {
    if (Date.now() < nextDemoPoll) return false
    nextDemoPoll = Date.now() + 5_000
    const result = await runDemosTick({ ownerDb, secretsKey, fetch, deleteObject: (key) => storage.deleteAttachment(key) })
    return result.started || result.advanced > 0 || result.expired > 0
  },
}, {
  name: "account_lifecycle",
  poll: async () => {
    if (Date.now() < nextAccountPoll) return false
    nextAccountPoll = Date.now() + 86_400_000
    const result = await runAccountLifecycleTick(ownerDb, {
      notify: { sendReminder: (email, mail) => mailer.send({ to: email, ...mail }) },
      onboardingUrl: `${env.WEB_URL.replace(/\/+$/, "")}/onboarding`,
      // Lleva al panel ya adentro, como «Reenviar el enlace» de la pantalla de entrar.
      verificationUrl: (email) =>
        emailVerificationUrl({
          secret: env.BETTER_AUTH_SECRET,
          authUrl: env.BETTER_AUTH_URL,
          email,
          callbackURL: `${env.WEB_URL.replace(/\/+$/, "")}/`,
          expiresInSeconds: REMINDER_VERIFICATION_TTL_SECONDS,
        }),
      verificationDays: REMINDER_VERIFICATION_TTL_SECONDS / 86_400,
    })
    for (const error of result.errors) console.error(`worker: account_lifecycle ${error}`)
    return result.reminders > 0 || result.cleaned > 0
  },
})

// La clave de «Conectar con Facebook» vence a los 60 días: se renueva sola (#121).
const metaApp =
  env.META_APP_ID.trim() && env.META_APP_SECRET.trim()
    ? { appId: env.META_APP_ID.trim(), appSecret: env.META_APP_SECRET.trim(), graphVersion: env.META_GRAPH_VERSION }
    : null
if (metaApp) {
  let nextTokenPoll = 0
  queues.push({
    name: "whatsapp_tokens",
    poll: async () => {
      if (Date.now() < nextTokenPoll) return false
      nextTokenPoll = Date.now() + 12 * 3_600_000
      const result = await runSignupTokenTick(ownerDb, db, { app: metaApp, secretsKey, fetch })
      for (const error of result.errors) console.error(`worker: whatsapp_tokens ${error}`)
      return result.renewed > 0
    },
  })
} else if (env.META_APP_ID.trim() || env.META_APP_SECRET.trim()) {
  console.warn("worker: falta META_APP_ID o META_APP_SECRET; la clave de «Conectar con Facebook» no se renovará sola.")
}

// La clave de una conexión con la app propia de la clínica no se renueva sola: se avisa antes de que venza.
let nextOwnAppTokenPoll = 0
queues.push({
  name: "whatsapp_own_app_tokens",
  poll: async () => {
    if (Date.now() < nextOwnAppTokenPoll) return false
    nextOwnAppTokenPoll = Date.now() + 12 * 3_600_000
    const result = await runOwnAppTokenTick(ownerDb, db)
    for (const error of result.errors) console.error(`worker: whatsapp_own_app_tokens ${error}`)
    return false
  },
})

// Producción: sin un backup verificado en 26 horas, o si el último falló, Soporte recibe el caso.
if (env.NODE_ENV === "production") {
  const watchingSince = new Date()
  let nextBackupPoll = 0
  queues.push({
    name: "backup_watch",
    poll: async () => {
      if (Date.now() < nextBackupPoll) return false
      nextBackupPoll = Date.now() + 3_600_000
      const result = await runBackupWatchTick(ownerDb, { expectedSince: watchingSince })
      if (result.problem) console.error(`worker: backup_watch ${result.problem}`)
      return false
    },
  })
}

console.log(`worker: consumiendo ${queues.map((q) => q.name).join(", ")}`)
while (!stopping) {
  try {
    let worked = false
    for (const queue of queues) {
      if (stopping) break
      try {
        // eslint-disable-next-line no-await-in-loop
        worked = (await queue.poll()) || worked
      } catch (error) {
        // Sin ack: el mensaje vuelve a ser visible tras el vt.
        console.error(`worker: error en cola ${queue.name}`, error)
      }
    }
    if (!worked) {
      const idle = Promise.withResolvers<void>()
      setTimeout(idle.resolve, 1_000)
      await idle.promise
    }
  } catch (error) {
    console.error("worker: error en loop", error)
    const backoff = Promise.withResolvers<void>()
    setTimeout(backoff.resolve, 2_000)
    await backoff.promise
  }
}
process.exit(0)

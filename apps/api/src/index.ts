import { serve } from "@hono/node-server"
import type { Context } from "hono"
import { createKairosWriter, decisionKeyStartProblem, embedderFromEnv, kairosModelNotice, platformLlmFromEnv } from "@odentia/agent"
import { type Auth, createAuth } from "@odentia/auth"
import { configureMetaGraphVersion } from "@odentia/channels"
import type { DomainProduct } from "@odentia/clinical"
import { createAppDb, createOwnerDb } from "@odentia/db"
import { configureMailLinks, createMailer } from "@odentia/mail"
import { adminChannelsFromEnv, adminChannelsWarning, clinicHostsFromEnv, createStorage, fakeAddressProvider, geoapifyProvider, googlePlacesProvider, kairosAiUseRecorder, mailBrandDomains, onDomain, secretsKeyFromEnv, trustedOriginsOn } from "@odentia/services"
import { createApp } from "./app.js"
import { env } from "./env.js"
import { instagramLoginFromEnv, metaPagesFromEnv } from "./routes/meta-pages.js"
import { metaSignupFromEnv } from "./routes/whatsapp-signup.js"

// Una sola versión del Graph de Meta: el botón de Facebook, WhatsApp, Messenger e Instagram.
configureMetaGraphVersion(env.META_GRAPH_VERSION)
const metaSignup = metaSignupFromEnv(env)
// Términos, Privacidad y Ayuda del pie de cada correo.
// El pie de cada correo lleva la web de su marca: la de latidIA, en su dominio (issue 229).
configureMailLinks(env.WEB_URL, mailBrandDomains(env.productDomains))
const db = createAppDb(env.APP_DATABASE_URL)
const ownerDb = createOwnerDb(env.DATABASE_URL)
const secretsKey = secretsKeyFromEnv(env.SECRETS_KEY)
// Sin la clave de Jev el agente sigue, pero lo ajeno se cobra: que se vea en el registro (ADR 0047).
const decisionKeyProblem = decisionKeyStartProblem(env)
if (decisionKeyProblem) console.error(`api: ${decisionKeyProblem}`)
const mailer = createMailer({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  user: env.SMTP_USER || undefined,
  pass: env.SMTP_PASS || undefined,
  from: env.SMTP_FROM,
  fromByBrand: {
    ...(env.MEDICAL_SMTP_FROM ? { latidia: env.MEDICAL_SMTP_FROM } : {}),
    ...(env.OPTICAL_SMTP_FROM ? { vistia: env.OPTICAL_SMTP_FROM } : {}),
  },
})
// Las conversaciones de la administración («Escribir» y las respuestas) por su propio canal de
// ZeptoMail, con el mismo servidor y remitentes; sin él, por el de siempre.
const conversationMailer =
  env.CONVERSATION_SMTP_USER && env.CONVERSATION_SMTP_PASS
    ? createMailer({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        user: env.CONVERSATION_SMTP_USER,
        pass: env.CONVERSATION_SMTP_PASS,
        from: env.SMTP_FROM,
        fromByBrand: {
          ...(env.MEDICAL_SMTP_FROM ? { latidia: env.MEDICAL_SMTP_FROM } : {}),
          ...(env.OPTICAL_SMTP_FROM ? { vistia: env.OPTICAL_SMTP_FROM } : {}),
        },
      })
    : undefined
if (Boolean(env.CONVERSATION_SMTP_USER) !== Boolean(env.CONVERSATION_SMTP_PASS)) {
  console.warn("CONVERSATION_SMTP_USER y CONVERSATION_SMTP_PASS van juntos: con uno solo, las conversaciones salen por SMTP_USER (docs/deployment.md).")
}
const authOptions = {
  db,
  ownerDb,
  mailer,
  secret: env.BETTER_AUTH_SECRET,
  googleClientId: env.GOOGLE_CLIENT_ID,
  googleClientSecret: env.GOOGLE_CLIENT_SECRET,
  passwordBreachCheck: env.PASSWORD_BREACH_CHECK !== "false",
  clientIpHeader: env.CLIENT_IP_HEADER,
}
const auth = createAuth({
  ...authOptions,
  baseURL: env.BETTER_AUTH_URL,
  webURL: env.WEB_URL,
  cookieDomain: env.COOKIE_DOMAIN,
  trustedOrigins: env.trustedOrigins,
})
// Cada producto en su dominio (decisión 9 del issue 229; latidIA en el suyo): misma base y
// mismo secreto, su propia cookie. Quien trabaja en varios productos entra una vez en cada uno.
const productAuth: Partial<Record<DomainProduct, Auth>> = {}
for (const [product, domain] of Object.entries(env.productDomains) as [DomainProduct, string | undefined][]) {
  if (!domain) continue
  productAuth[product] = createAuth({
    ...authOptions,
    product,
    baseURL: onDomain(env.BETTER_AUTH_URL, env.COOKIE_DOMAIN, domain),
    webURL: onDomain(env.WEB_URL, env.COOKIE_DOMAIN, domain),
    cookieDomain: domain,
    trustedOrigins: trustedOriginsOn(env.trustedOrigins, env.COOKIE_DOMAIN, domain, [new URL(env.ADMIN_URL).origin]),
  })
}
if (env.NODE_ENV === "production" && !env.CLIENT_IP_HEADER) {
  console.warn("CLIENT_IP_HEADER vacío: todas las personas comparten el límite de intentos de Better Auth (docs/deployment.md).")
}

// El modelo de la plataforma (el mismo `LLM_*`), y su gasto, como gasto de Sallca: Kairós prepara, nunca envía.
const llm = platformLlmFromEnv(env)
const kairos = createKairosWriter({ platform: llm, onUse: kairosAiUseRecorder(ownerDb) })
// Sin la clave, Kairós redacta con plantillas y lo dice en la pantalla: nunca un error.
const kairosNotice = kairosModelNotice(llm)
if (env.NODE_ENV === "production" && kairosNotice) console.warn(kairosNotice)
if (env.NODE_ENV === "production" && !env.INBOUND_EMAIL_SECRET) {
  console.warn("INBOUND_EMAIL_SECRET vacío: el correo entrante (los buzones y la dirección de cada persona del equipo) no llega al ARM (docs/deployment.md).")
}

// WhatsApp, Instagram y Messenger de la administración: cada canal con sus variables.
const adminChannels = adminChannelsFromEnv(env)
const adminChannelsNotice = adminChannelsWarning(env)
if (env.NODE_ENV === "production" && adminChannelsNotice) console.warn(adminChannelsNotice)
/** Solo pruebas (e2e): lo que iría a graph.facebook.com va al servidor local que hace de Meta. */
const adminChannelsFetch = env.ADMIN_META_GRAPH_URL
  ? ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      return fetch(url.replace(/^https:\/\/graph\.facebook\.com/, env.ADMIN_META_GRAPH_URL), init)
    }) as typeof fetch
  : undefined

const app = createApp({
  auth,
  db,
  ownerDb,
  secretsKey,
  validateExternal: env.CHANNEL_VALIDATE_EXTERNAL !== "false",
  webhookBaseUrl: env.BETTER_AUTH_URL,
  storage: createStorage({
    endpoint: env.S3_ENDPOINT,
    region: env.S3_REGION,
    accessKeyId: env.S3_ACCESS_KEY,
    secretAccessKey: env.S3_SECRET_KEY,
    avatarsBucket: env.S3_BUCKET,
    publicBaseUrl: env.S3_PUBLIC_URL,
    attachmentsBucket: env.S3_ATTACHMENTS_BUCKET,
  }),
  trustedOrigins: env.trustedOrigins,
  cookieDomain: env.COOKIE_DOMAIN,
  productDomains: env.productDomains,
  productAuth,
  webURL: env.WEB_URL,
  adminURL: env.ADMIN_URL,
  mailer,
  complaintsEmail: env.COMPLAINTS_EMAIL || undefined,
  ...(conversationMailer ? { conversationMailer } : {}),
  listenUrl: env.APP_DATABASE_URL,
  // La dirección real de quien llama a las rutas públicas (el chat web, el
  // registro): detrás del túnel, la conexión es siempre la del túnel.
  ...(env.CLIENT_IP_HEADER
    ? { registrationRemoteAddress: (c: Context) => c.req.header(env.CLIENT_IP_HEADER as string)?.split(",")[0]?.trim() || undefined }
    : {}),
  llm,
  kairos,
  inboundEmailSecret: env.INBOUND_EMAIL_SECRET || undefined,
  decisions: {
    ...(env.JEV_API_KEY ? { jev: { apiKey: env.JEV_API_KEY, baseUrl: env.JEV_BASE_URL, model: env.JEV_MODEL } } : {}),
    timeoutMs: env.DECISIONS_TIMEOUT_MS,
  },
  metaSignup,
  metaPages: metaPagesFromEnv(metaSignup, env),
  // Sin la app de odentIA no hay dirección de avisos: Instagram quedaría conectado sin recibir nada.
  instagramLogin: metaSignup ? instagramLoginFromEnv(env) : undefined,
  adminChannels,
  adminChannelsFetch,
  vapidPublicKey: env.VAPID_PUBLIC_KEY,
  embedder: embedderFromEnv(env),
  // `fake`: el proveedor de demostración de dev y e2e (sin red); el entorno lo impide con canales reales.
  addressProviders: {
    sede: env.GOOGLE_MAPS_API_KEY === "fake" ? fakeAddressProvider("google") : env.GOOGLE_MAPS_API_KEY ? googlePlacesProvider(env.GOOGLE_MAPS_API_KEY) : null,
    paciente: env.GEOAPIFY_API_KEY === "fake" ? fakeAddressProvider("geoapify") : env.GEOAPIFY_API_KEY ? geoapifyProvider(env.GEOAPIFY_API_KEY) : null,
  },
  geoapifyDailyLimit: env.GEOAPIFY_DAILY_LIMIT,
  // Solo los subdominios de clínicas reales llegan a las pantallas (ADR 0193). Sin token ni zonas, no hace nada.
  clinicHosts: clinicHostsFromEnv(env, { webURL: env.WEB_URL, cookieDomain: env.COOKIE_DOMAIN, productDomains: env.productDomains }),
  expectBackups: env.NODE_ENV === "production",
  mailbox: {
    gmail: { clientId: env.GMAIL_CLIENT_ID, clientSecret: env.GMAIL_CLIENT_SECRET, redirectUri: env.GMAIL_REDIRECT_URI },
    microsoft365: { clientId: env.MICROSOFT_MAIL_CLIENT_ID, clientSecret: env.MICROSOFT_MAIL_CLIENT_SECRET, redirectUri: env.MICROSOFT_MAIL_REDIRECT_URI, tenant: env.MICROSOFT_MAIL_TENANT },
  },
})

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`api listening on :${info.port}`)
})

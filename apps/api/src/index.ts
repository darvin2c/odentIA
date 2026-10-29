import { serve } from "@hono/node-server"
import type { Context } from "hono"
import { decisionKeyStartProblem, embedderFromEnv, platformLlmFromEnv } from "@odentia/agent"
import { createAuth } from "@odentia/auth"
import { configureMetaGraphVersion } from "@odentia/channels"
import { createAppDb, createOwnerDb } from "@odentia/db"
import { configureMailLinks, createMailer } from "@odentia/mail"
import { createStorage, fakeAddressProvider, geoapifyProvider, googlePlacesProvider, onDomain, secretsKeyFromEnv, trustedOriginsOn } from "@odentia/services"
import { createApp } from "./app.js"
import { env } from "./env.js"
import { metaSignupFromEnv } from "./routes/whatsapp-signup.js"

// Una sola versión del Graph de Meta: el botón de Facebook, WhatsApp, Messenger e Instagram.
configureMetaGraphVersion(env.META_GRAPH_VERSION)
// Términos, Privacidad y Ayuda del pie de cada correo.
// El pie de cada correo lleva la web de su marca: la de latidIA, en su dominio (issue 229).
configureMailLinks(env.WEB_URL, { latidia: env.MEDICAL_DOMAIN })
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
  fromByBrand: env.MEDICAL_SMTP_FROM ? { latidia: env.MEDICAL_SMTP_FROM } : {},
})
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
// latidIA en su dominio (decisión 9 del issue 229): misma base y mismo secreto,
// su propia cookie. Quien trabaja en los dos productos entra una vez en cada uno.
const productAuth = env.MEDICAL_DOMAIN
  ? {
      medical: createAuth({
        ...authOptions,
        product: "medical",
        baseURL: onDomain(env.BETTER_AUTH_URL, env.COOKIE_DOMAIN, env.MEDICAL_DOMAIN),
        webURL: onDomain(env.WEB_URL, env.COOKIE_DOMAIN, env.MEDICAL_DOMAIN),
        cookieDomain: env.MEDICAL_DOMAIN,
        trustedOrigins: trustedOriginsOn(env.trustedOrigins, env.COOKIE_DOMAIN, env.MEDICAL_DOMAIN, [new URL(env.ADMIN_URL).origin]),
      }),
    }
  : {}
if (env.NODE_ENV === "production" && !env.CLIENT_IP_HEADER) {
  console.warn("CLIENT_IP_HEADER vacío: todas las personas comparten el límite de intentos de Better Auth (docs/deployment.md).")
}

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
  foundersEmail: env.FOUNDERS_EMAIL || undefined,
  listenUrl: env.APP_DATABASE_URL,
  // La dirección real de quien llama a las rutas públicas (el chat web, el
  // registro): detrás del túnel, la conexión es siempre la del túnel.
  ...(env.CLIENT_IP_HEADER
    ? { registrationRemoteAddress: (c: Context) => c.req.header(env.CLIENT_IP_HEADER as string)?.split(",")[0]?.trim() || undefined }
    : {}),
  llm: platformLlmFromEnv(env),
  decisions: {
    ...(env.JEV_API_KEY ? { jev: { apiKey: env.JEV_API_KEY, baseUrl: env.JEV_BASE_URL, model: env.JEV_MODEL } } : {}),
    timeoutMs: env.DECISIONS_TIMEOUT_MS,
  },
  metaSignup: metaSignupFromEnv(env),
  embedder: embedderFromEnv(env),
  // `fake`: el proveedor de demostración de dev y e2e (sin red); el entorno lo impide con canales reales.
  addressProviders: {
    sede: env.GOOGLE_MAPS_API_KEY === "fake" ? fakeAddressProvider("google") : env.GOOGLE_MAPS_API_KEY ? googlePlacesProvider(env.GOOGLE_MAPS_API_KEY) : null,
    paciente: env.GEOAPIFY_API_KEY === "fake" ? fakeAddressProvider("geoapify") : env.GEOAPIFY_API_KEY ? geoapifyProvider(env.GEOAPIFY_API_KEY) : null,
  },
  geoapifyDailyLimit: env.GEOAPIFY_DAILY_LIMIT,
  expectBackups: env.NODE_ENV === "production",
  mailbox: {
    gmail: { clientId: env.GMAIL_CLIENT_ID, clientSecret: env.GMAIL_CLIENT_SECRET, redirectUri: env.GMAIL_REDIRECT_URI },
    microsoft365: { clientId: env.MICROSOFT_MAIL_CLIENT_ID, clientSecret: env.MICROSOFT_MAIL_CLIENT_SECRET, redirectUri: env.MICROSOFT_MAIL_REDIRECT_URI, tenant: env.MICROSOFT_MAIL_TENANT },
  },
})

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`api listening on :${info.port}`)
})

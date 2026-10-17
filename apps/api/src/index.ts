import { serve } from "@hono/node-server"
import { embedderFromEnv, platformLlmFromEnv } from "@odentia/agent"
import { createAuth } from "@odentia/auth"
import { configureMetaGraphVersion } from "@odentia/channels"
import { createAppDb, createOwnerDb } from "@odentia/db"
import { createMailer } from "@odentia/mail"
import { createStorage, secretsKeyFromEnv } from "@odentia/services"
import { createApp } from "./app.js"
import { env } from "./env.js"
import { metaSignupFromEnv } from "./routes/whatsapp-signup.js"

// Una sola versión del Graph de Meta: el botón de Facebook, WhatsApp, Messenger e Instagram.
configureMetaGraphVersion(env.META_GRAPH_VERSION)
const db = createAppDb(env.APP_DATABASE_URL)
const ownerDb = createOwnerDb(env.DATABASE_URL)
const secretsKey = secretsKeyFromEnv(env.SECRETS_KEY)
const mailer = createMailer({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  user: env.SMTP_USER || undefined,
  pass: env.SMTP_PASS || undefined,
  from: env.SMTP_FROM,
})
const auth = createAuth({
  db,
  ownerDb,
  mailer,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  webURL: env.WEB_URL,
  cookieDomain: env.COOKIE_DOMAIN,
  trustedOrigins: env.trustedOrigins,
  googleClientId: env.GOOGLE_CLIENT_ID,
  googleClientSecret: env.GOOGLE_CLIENT_SECRET,
})

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
  webURL: env.WEB_URL,
  adminURL: env.ADMIN_URL,
  mailer,
  complaintsEmail: env.COMPLAINTS_EMAIL || undefined,
  listenUrl: env.APP_DATABASE_URL,
  llm: platformLlmFromEnv(env),
  decisions: {
    ...(env.JEV_API_KEY ? { jev: { apiKey: env.JEV_API_KEY, baseUrl: env.JEV_BASE_URL, model: env.JEV_MODEL } } : {}),
    ...(env.OPENAI_DECISIONS_API_KEY
      ? { openai: { apiKey: env.OPENAI_DECISIONS_API_KEY, baseUrl: env.OPENAI_DECISIONS_BASE_URL, model: env.OPENAI_DECISIONS_MODEL } }
      : {}),
    timeoutMs: env.DECISIONS_TIMEOUT_MS,
  },
  metaSignup: metaSignupFromEnv(env),
  embedder: embedderFromEnv(env),
  mailbox: {
    gmail: { clientId: env.GMAIL_CLIENT_ID, clientSecret: env.GMAIL_CLIENT_SECRET, redirectUri: env.GMAIL_REDIRECT_URI },
    microsoft365: { clientId: env.MICROSOFT_MAIL_CLIENT_ID, clientSecret: env.MICROSOFT_MAIL_CLIENT_SECRET, redirectUri: env.MICROSOFT_MAIL_REDIRECT_URI, tenant: env.MICROSOFT_MAIL_TENANT },
  },
})

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`api listening on :${info.port}`)
})

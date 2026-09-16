import { z } from "zod"

const envSchema = z.object({
  DATABASE_URL: z.string().min(1),
  APP_DATABASE_URL: z.string().min(1),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_URL: z.string().url(),
  WEB_URL: z.string().url(),
  COOKIE_DOMAIN: z.string().min(1),
  TRUSTED_ORIGINS: z.string().min(1),
  GOOGLE_CLIENT_ID: z.string().optional().default(""),
  GOOGLE_CLIENT_SECRET: z.string().optional().default(""),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int(),
  SMTP_USER: z.string().optional().default(""),
  SMTP_PASS: z.string().optional().default(""),
  SMTP_FROM: z.string().min(1),
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default("auto"),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ATTACHMENTS_BUCKET: z.string().min(1),
  S3_PUBLIC_URL: z.string().url(),
  SECRETS_KEY: z.string().min(1),
  CHANNEL_VALIDATE_EXTERNAL: z.string().optional().default("true"),
  PORT: z.coerce.number().int().default(3001),
})

function loadEnv() {
  const parsed = envSchema.safeParse(process.env)
  if (!parsed.success) {
    console.error("Variables de entorno inválidas:", parsed.error.flatten().fieldErrors)
    process.exit(1)
  }
  const { TRUSTED_ORIGINS, ...rest } = parsed.data
  return { ...rest, trustedOrigins: TRUSTED_ORIGINS.split(",").map((o) => o.trim()) }
}

export const env = loadEnv()
export type Env = typeof env

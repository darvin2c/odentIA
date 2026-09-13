import { serve } from "@hono/node-server";
import { createAuth } from "@odentia/auth";
import { createAppDb } from "@odentia/db";
import { createMailer } from "@odentia/mail";
import { createApp } from "./app.js";
import { env } from "./env.js";

const db = createAppDb(env.APP_DATABASE_URL);
const mailer = createMailer({
  host: env.SMTP_HOST,
  port: env.SMTP_PORT,
  user: env.SMTP_USER || undefined,
  pass: env.SMTP_PASS || undefined,
  from: env.SMTP_FROM,
});
const auth = createAuth({
  db,
  mailer,
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  webURL: env.WEB_URL,
  cookieDomain: env.COOKIE_DOMAIN,
  trustedOrigins: env.trustedOrigins,
});

const app = createApp({
  auth,
  db,
  trustedOrigins: env.trustedOrigins,
  cookieDomain: env.COOKIE_DOMAIN,
  listenUrl: env.APP_DATABASE_URL,
});

serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  console.log(`api listening on :${info.port}`);
});

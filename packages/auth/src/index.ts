import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import type { Db } from "@odentia/db";
import {
  invitationTemplate,
  resetPasswordTemplate,
  verifyEmailTemplate,
  type Mailer,
} from "@odentia/mail";

export interface CreateAuthOptions {
  db: Db;
  mailer: Mailer;
  secret: string;
  baseURL: string;
  webURL: string;
  cookieDomain: string;
  trustedOrigins: string[];
}

export function createAuth({
  db,
  mailer,
  secret,
  baseURL,
  webURL,
  cookieDomain,
  trustedOrigins,
}: CreateAuthOptions) {
  return betterAuth({
    appName: "odentIA",
    secret,
    baseURL,
    database: drizzleAdapter(db, { provider: "pg" }),
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      sendResetPassword: async ({ user, url }) => {
        const template = resetPasswordTemplate({ url });
        await mailer.send({ to: user.email, ...template });
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        const template = verifyEmailTemplate({ url });
        await mailer.send({ to: user.email, ...template });
      },
    },
    advanced: {
      crossSubDomainCookies: { enabled: true, domain: cookieDomain },
    },
    trustedOrigins,
    plugins: [
      organization({
        sendInvitationEmail: async ({ email, inviter, organization: org, invitation }) => {
          const template = invitationTemplate({
            organizationName: org.name,
            inviterName: inviter.user.name,
            url: `${webURL}/accept-invitation/${invitation.id}`,
          });
          await mailer.send({ to: email, ...template });
        },
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
export type Session = Auth["$Infer"]["Session"];

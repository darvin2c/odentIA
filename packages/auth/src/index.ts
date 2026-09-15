import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { organization } from "better-auth/plugins";
import type { Db } from "@odentia/db";
import {
  changeEmailConfirmationTemplate,
  changeEmailVerificationTemplate,
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
  /** Client ID de Google OAuth; vacío si no hay OAuth configurado. */
  googleClientId: string;
  /** Client secret de Google OAuth; vacío si no hay OAuth configurado. */
  googleClientSecret: string;
}

function isChangeEmailToken(token: string): boolean {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1] ?? "", "base64url").toString()) as {
      requestType?: string;
    };
    return payload.requestType === "change-email-verification";
  } catch {
    return false;
  }
}

export function createAuth({
  db,
  mailer,
  secret,
  baseURL,
  webURL,
  cookieDomain,
  trustedOrigins,
  googleClientId,
  googleClientSecret,
}: CreateAuthOptions) {
  return betterAuth({
    appName: "odentIA",
    secret,
    baseURL,
    database: drizzleAdapter(db, { provider: "pg" }),
    socialProviders: {
      ...(googleClientId && googleClientSecret
        ? { google: { clientId: googleClientId, clientSecret: googleClientSecret } }
        : {}),
    },
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
      sendVerificationEmail: async ({ user, url, token }) => {
        const template = isChangeEmailToken(token)
          ? changeEmailVerificationTemplate({ url })
          : verifyEmailTemplate({ url });
        await mailer.send({ to: user.email, ...template });
      },
    },
    user: {
      additionalFields: {
        firstName: { type: "string", required: false, defaultValue: "" },
        lastName: { type: "string", required: false, defaultValue: "" },
      },
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
          const template = changeEmailConfirmationTemplate({ newEmail, url });
          await mailer.send({ to: user.email, ...template });
        },
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

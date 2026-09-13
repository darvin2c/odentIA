import { redirect } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { getRequestHeaders } from "@tanstack/react-start/server";
import { authClient } from "./auth-client";

export interface SessionInfo {
  userId: string;
  email: string;
  name: string;
  emailVerified: boolean;
}

/** Cabeceras de la petición entrante en SSR (cookies); vacío en el cliente. */
export const ssrFetchOptions = createIsomorphicFn()
  .server(() => ({ headers: getRequestHeaders() }))
  .client(() => ({}));

/** Sesión actual o redirect a /login. Para beforeLoad de rutas privadas. */
export async function requireSession(): Promise<SessionInfo> {
  // En SSR el fetch corre en Node y no ve las cookies del navegador: hay que
  // reenviar las cabeceras de la petición entrante.
  const { data } = await authClient.getSession({
    fetchOptions: ssrFetchOptions(),
  });
  if (!data) {
    throw redirect({ to: "/login" });
  }
  return {
    userId: data.user.id,
    email: data.user.email,
    name: data.user.name,
    emailVerified: data.user.emailVerified,
  };
}

/** Sesión con correo verificado; si no, a /verify-email-sent. */
export async function requireVerifiedSession(): Promise<SessionInfo> {
  const session = await requireSession();
  if (!session.emailVerified) {
    throw redirect({ to: "/verify-email-sent" });
  }
  return session;
}

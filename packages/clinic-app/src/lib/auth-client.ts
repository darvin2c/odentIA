import { organizationClient } from "better-auth/client/plugins"
import type { AuthFetch } from "@odentia/ui-patterns"
import { createAuthClient } from "better-auth/react"
import { adminAc, defaultAc, memberAc, ownerAc } from "better-auth/plugins/organization/access"
import { apiTransport } from "./ssr-fetch"

export const API_URL = import.meta.env.VITE_API_URL as string

// Roles espejo del servidor (packages/auth): built-ins más operativos sin
// gestión de miembros ni invitaciones; solo para inferir los literales de
// rol en el cliente (invitar/cambiar rol). La autorización la aplica el servidor.
const staffRole = defaultAc.newRole({
  organization: [],
  member: [],
  invitation: [],
  team: [],
  ac: ["read"],
})

export const authClient = createAuthClient({
  baseURL: API_URL,
  fetchOptions: { credentials: "include", customFetchImpl: apiTransport },
  plugins: [
    organizationClient({
      roles: {
        owner: ownerAc,
        admin: adminAc,
        member: memberAc,
        reception: staffRole,
        clinician: staffRole,
        cashier: staffRole,
      },
    }),
  ],
})

/** Rutas propias del servidor de acceso (enlace de acceso) con el mismo cliente y cookies. */
export const authFetch: AuthFetch = async (path, init) => {
  const { data, error } = await authClient.$fetch(path, { method: init?.method ?? "GET", body: init?.body })
  return {
    data,
    error: error ? { message: error.message, code: (error as { code?: string }).code, status: error.status } : null,
  }
}

import { organizationClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"
import { adminAc, defaultAc, memberAc, ownerAc } from "better-auth/plugins/organization/access"

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
  fetchOptions: { credentials: "include" },
  plugins: [
    organizationClient({
      roles: {
        owner: ownerAc,
        admin: adminAc,
        member: memberAc,
        reception: staffRole,
        dentist: staffRole,
        cashier: staffRole,
      },
    }),
  ],
})

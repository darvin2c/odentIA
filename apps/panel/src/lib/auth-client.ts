import { inferAdditionalFields, organizationClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

export const API_URL = import.meta.env.VITE_API_URL as string

export const authClient = createAuthClient({
  baseURL: API_URL,
  fetchOptions: { credentials: "include" },
  plugins: [
    organizationClient(),
    inferAdditionalFields({
      user: {
        firstName: { type: "string", required: false, defaultValue: "" },
        lastName: { type: "string", required: false, defaultValue: "" },
      },
    }),
  ],
})

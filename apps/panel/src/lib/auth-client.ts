import { inferAdditionalFields, organizationClient, twoFactorClient } from "better-auth/client/plugins"
import { createAuthClient } from "better-auth/react"

export const API_URL = import.meta.env.VITE_API_URL as string

/** Lleva el `next` del login al challenge para volver sin ciclos. */
function nextOf(url: string): string {
  try {
    const params = new URL(url, "http://local").searchParams
    const next = params.get("next")
    return next ? `?next=${encodeURIComponent(next)}` : ""
  } catch {
    return ""
  }
}

export const authClient = createAuthClient({
  baseURL: API_URL,
  fetchOptions: { credentials: "include" },
  plugins: [
    organizationClient(),
    twoFactorClient({
      onTwoFactorRedirect() {
        window.location.href = `/two-factor${nextOf(window.location.href)}`
      },
    }),
    inferAdditionalFields({
      user: {
        firstName: { type: "string", required: false, defaultValue: "" },
        lastName: { type: "string", required: false, defaultValue: "" },
      },
    }),
  ],
})

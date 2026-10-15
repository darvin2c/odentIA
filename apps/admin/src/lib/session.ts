import { redirect } from "@tanstack/react-router"
import { z } from "zod"
import { ApiError, api } from "./api"
import { loginUrl } from "./host"

export const adminSessionSchema = z.object({
  actor: z.object({ userId: z.string(), role: z.enum(["admin", "support"]) }),
  user: z.object({ name: z.string(), email: z.string(), image: z.string().nullable().optional() }),
  verified: z.boolean(),
})
export type AdminSession = z.infer<typeof adminSessionSchema>

export async function requireAdminSession(): Promise<AdminSession> {
  let session: AdminSession
  try {
    session = adminSessionSchema.parse(await api<unknown>("/api/admin/access/session"))
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) throw redirect({ href: loginUrl() })
    throw error
  }
  if (!session.verified) throw redirect({ to: "/security" })
  return session
}

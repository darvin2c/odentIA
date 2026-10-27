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

/**
 * Las pantallas solo de la administración (Cobros y planes, Comisiones): el
 * menú no las muestra a soporte y, si entra con la dirección, vuelve a Inicio
 * en vez de ver errores de acceso. La API tampoco le da los datos (ADR 0094).
 */
export function requireAdminRole({ context }: { context: { adminSession: AdminSession } }): void {
  if (context.adminSession.actor.role !== "admin") throw redirect({ to: "/" })
}

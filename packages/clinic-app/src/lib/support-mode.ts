import { ApiError, apiFetch } from "./api"
import { API_URL } from "./auth-client"
import type { SessionInfo } from "./guards"
import type { FullOrganization } from "./org-access"

/**
 * Soporte de odentIA mirando la clínica con el permiso que dio la propietaria o
 * un administrador (por un rol, solo lectura). No es una persona de la clínica:
 * no tiene sesión de la clínica ni membresía; su cookie la canjea la API por un
 * pase de un solo uso. La API rechaza toda escritura y toda descarga; la
 * pantalla solo acompaña (esconde lo que no puede hacer y dice que solo mira).
 */
export interface SupportMode {
  staffName: string
  viewRole: string
  viewRoleLabel: string
  expiresAt: string
  caseId: string
}

interface SupportMe extends SupportMode {
  staffUserId: string
  organization: { id: string; name: string; slug: string; logo: string | null }
  members: FullOrganization["members"]
}

/** La sesión de soporte de este navegador para esta clínica, o nulo si no hay. */
export async function loadSupportSession(
  slug: string,
  fetchOptions?: { headers?: Record<string, string> },
): Promise<{ session: SessionInfo; org: FullOrganization; support: SupportMode } | null> {
  try {
    const { data } = await apiFetch<{ data: SupportMe }>(
      "/api/support-session/me",
      fetchOptions?.headers ? { headers: fetchOptions.headers } : undefined,
    )
    if (data.organization.slug !== slug) return null
    const org = {
      id: data.organization.id,
      name: data.organization.name,
      slug: data.organization.slug,
      logo: data.organization.logo,
      createdAt: new Date(0),
      metadata: null,
      members: [
        ...data.members,
        // Soporte, con el rol con que mira: lo que decide qué pantallas abre.
        {
          id: `soporte:${data.staffUserId}`,
          organizationId: data.organization.id,
          userId: data.staffUserId,
          role: data.viewRole,
          createdAt: new Date(),
          user: { id: data.staffUserId, name: data.staffName, email: "", image: null },
        },
      ],
      invitations: [],
    } as unknown as FullOrganization
    return {
      session: {
        userId: data.staffUserId,
        email: "",
        name: data.staffName,
        image: null,
        emailVerified: true,
      },
      org,
      support: {
        staffName: data.staffName,
        viewRole: data.viewRole,
        viewRoleLabel: data.viewRoleLabel,
        expiresAt: data.expiresAt,
        caseId: data.caseId,
      },
    }
  } catch (error) {
    if (error instanceof ApiError) return null
    return null
  }
}

/** ¿El error dice que el acceso de soporte terminó? */
export function isSupportEnded(error: unknown): boolean {
  return error instanceof ApiError && error.shape.code === "SUPPORT_ACCESS_ENDED"
}

/** Canjea el pase de la administración por la sesión de solo mirar. */
export async function redeemSupportPass(pass: string): Promise<void> {
  await apiFetch("/api/support-session/redeem", { method: "POST", body: JSON.stringify({ pass }) })
}

/** «Salir»: termina la sesión de soporte en este navegador. */
export async function endSupportSession(): Promise<void> {
  await apiFetch("/api/support-session/end", { method: "POST", body: "{}" })
}

/** Por qué terminó el acceso: quién lo quitó, si venció o si salió. */
export async function supportEnding(): Promise<{
  at: string
  reason: string
  byName: string | null
} | null> {
  const response = await fetch(`${API_URL}/api/support-session/ended`, { credentials: "include" })
  if (!response.ok) return null
  return (
    (await response.json()) as {
      data: { at: string; reason: string; byName: string | null } | null
    }
  ).data
}

/** Con soporte mirando, ningún permiso de escritura: la pantalla no ofrece cambiar nada. */
export function supportCan(permission: string): boolean {
  return (
    !permission.endsWith(".write") &&
    !permission.endsWith(".decide") &&
    !permission.endsWith(".send")
  )
}

import { Button } from "@odentia/ui"
import { AuthCard, ErrorState, LoadingState } from "@odentia/ui-patterns"
import { createFileRoute, useNavigate, useParams } from "@tanstack/react-router"
import { useEffect, useRef, useState } from "react"
import { z } from "zod"
import { apiFetch } from "../../lib/api"
import { authClient } from "../../lib/auth-client"
import { tenantUrl } from "../../lib/host"

export const Route = createFileRoute("/accept-invitation/$invitationId")({
  component: AcceptInvitationPage,
})

type PageState =
  | { kind: "loading" }
  | { kind: "needs-auth"; email?: string }
  | { kind: "error"; message: string }

const acceptSchema = z.object({
  member: z.object({ organizationId: z.string() }).nullish(),
})

const myOrgsSchema = z.object({
  data: z.array(
    z.object({ organizationId: z.string(), slug: z.string(), role: z.string() }),
  ),
})

const profileSchema = z.object({ data: z.unknown().nullable() })

function AcceptInvitationPage() {
  const navigate = useNavigate()
  const { invitationId } = useParams({ from: "/accept-invitation/$invitationId" })
  const [state, setState] = useState<PageState>({ kind: "loading" })

  // StrictMode ejecuta el efecto dos veces en dev; la segunda aceptación
  // falla con "ya aceptada" y mostraría un error falso. Ejecutar una sola vez.
  const started = useRef(false)
  useEffect(() => {
    if (started.current) return
    started.current = true
    async function accept() {
      const { data: session } = await authClient.getSession()
      if (!session) {
        setState({ kind: "needs-auth" })
        return
      }
      const { data, error } = await authClient.organization.acceptInvitation({
        invitationId,
      })
      if (error) {
        setState({ kind: "error", message: "La invitación expiró o fue revocada." })
        return
      }
      const accepted = acceptSchema.safeParse(data)
      const organizationId = accepted.success ? accepted.data.member?.organizationId : undefined
      // Alta asistida: si la clínica aún no tiene perfil y quien entra puede
      // terminarla (owner/admin), reanuda el alta sin crear otra clínica.
      if (organizationId) {
        try {
          const orgs = myOrgsSchema.parse(await apiFetch<unknown>("/api/account/organizations"))
          const mine = orgs.data.find((org) => org.organizationId === organizationId)
          if (mine && (mine.role === "owner" || mine.role === "admin")) {
            const profile = profileSchema.parse(await apiFetch<unknown>("/api/org-profile"))
            if (profile.data === null) {
              await navigate({ to: "/onboarding", search: { continue: organizationId } })
              return
            }
          }
        } catch {
          // Sin lectura: se sigue al flujo normal de entrada.
        }
      }
      const { data: orgs } = await authClient.organization.list()
      const slug = organizationId ? orgs?.find((org) => org.id === organizationId)?.slug : undefined
      if (slug) {
        window.location.assign(tenantUrl(slug, "/home"))
        return
      }
      await navigate({ to: "/" })
    }
    void accept()
  }, [invitationId, navigate])

  if (state.kind === "loading") {
    return (
      <AuthCard title="Aceptando invitación">
        <LoadingState kind="indeterminate" message="Aceptando invitación…" />
      </AuthCard>
    )
  }

  if (state.kind === "needs-auth") {
    return (
      <AuthCard
        title="Tienes una invitación"
        description="Inicia sesión o crea tu cuenta para aceptarla."
      >
        <div className="flex flex-col gap-2">
          <Button className="w-full" onClick={() => void navigate({ to: "/login" })}>
            Iniciar sesión
          </Button>
          <Button
            variant="outline"
            className="w-full"
            onClick={() => void navigate({ to: "/register", search: { invitationId } })}
          >
            Crear cuenta
          </Button>
        </div>
      </AuthCard>
    )
  }

  return (
    <AuthCard title="Invitación no válida">
      <ErrorState message={state.message} />
      <Button variant="outline" className="w-full" onClick={() => void navigate({ to: "/login" })}>
        Ir a iniciar sesión
      </Button>
    </AuthCard>
  )
}

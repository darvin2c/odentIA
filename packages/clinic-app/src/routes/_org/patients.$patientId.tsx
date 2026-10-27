import { canAccess } from "@odentia/auth/permissions"
import { ErrorState, LoadingState, PageShell } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { createFileRoute, Outlet, redirect, useChildMatches, useNavigate } from "@tanstack/react-router"
import { useEffect } from "react"
import { usePermission } from "../../lib/crm"
import { fetchPersonOfPatient, personIdOfPatient, personOfPatientKey } from "../../lib/people"
import { QueryErrorState } from "../../lib/query-error"

/**
 * La ficha del paciente es la página de su persona (ADR 0029). Esta dirección
 * se conserva porque hay avisos, enlaces guardados y partes de la ficha que
 * solo conocen al paciente: busca a su persona y redirige con la misma
 * búsqueda (`?tab=` incluido). La atención y las impresiones siguen colgando
 * de aquí.
 */
export const Route = createFileRoute("/_org/patients/$patientId")({
  validateSearch: (search: Record<string, unknown>): Record<string, unknown> => search,
  // Se salta antes de pintar: con la persona ya conocida (o buscada al acercar el
  // puntero al enlace) no hay «Abriendo su página…» ni un viaje más. Sin permiso
  // o si la búsqueda falla, la página de abajo lo dice como siempre.
  beforeLoad: async ({ context, location, params, search }) => {
    if (location.pathname.replace(/\/+$/, "") !== `/patients/${params.patientId}`) return
    const role = context.org.members.find((member) => member.userId === context.session.userId)?.role ?? "member"
    if (!canAccess(role, "patients.read")) return
    const personId = await personIdOfPatient(params.patientId).catch(() => null)
    if (personId) throw redirect({ to: "/people/$personId", params: { personId }, search: search as never, replace: true })
  },
  component: PatientRoute,
})

function PatientRoute() {
  const childRoutes = useChildMatches({
    select: (matches) => matches.map((match) => match.routeId),
  })
  return childRoutes.length > 0 ? <Outlet /> : <PatientToPerson />
}

function PatientToPerson() {
  const { patientId } = Route.useParams()
  const search = Route.useSearch()
  const navigate = useNavigate()
  const canView = usePermission("patients.read")
  const person = useQuery({
    queryKey: personOfPatientKey(patientId),
    queryFn: () => fetchPersonOfPatient(patientId),
    enabled: canView,
    staleTime: Number.POSITIVE_INFINITY,
    retry: false,
  })
  const personId = person.data?.data.personId
  useEffect(() => {
    if (personId)
      void navigate({
        to: "/people/$personId",
        params: { personId },
        search: search as never,
        replace: true,
      })
  }, [personId, navigate, search])
  if (!canView)
    return (
      <PageShell>
        <ErrorState title="Sin acceso" message="No tienes permiso para ver a esta persona." />
      </PageShell>
    )
  if (person.isError)
    return (
      <PageShell>
        <QueryErrorState
          error={person.error}
          onRetry={() => void person.refetch()}
          notFound="Este paciente no existe o ya no está disponible. Vuelve a la lista de pacientes."
        />
      </PageShell>
    )
  return (
    <PageShell>
      <LoadingState message="Abriendo su página…" />
    </PageShell>
  )
}

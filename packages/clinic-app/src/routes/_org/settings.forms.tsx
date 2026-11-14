import { PageHeader } from "@odentia/ui-patterns"
import { createFileRoute, redirect } from "@tanstack/react-router"
import { ConsentSheetPage, ConsentTemplatesList } from "../../components/settings/consent-templates"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { FormTemplatesPageSkeleton } from "../../components/skeletons/settings"
import { usePermission } from "../../lib/crm"

export const Route = createFileRoute("/_org/settings/forms")({
  // `tab=consentimientos` queda por los enlaces guardados: es lo que abre esta página.
  validateSearch: (search: Record<string, unknown>): { tab?: "formularios" | "consentimientos"; consentimiento?: string } => ({
    ...(search.tab === "consentimientos" || search.tab === "formularios" ? { tab: search.tab } : {}),
    ...(typeof search.consentimiento === "string" && search.consentimiento ? { consentimiento: search.consentimiento } : {}),
  }),
  // Las fichas del equipo pasaron a «Fichas de consulta», con su lugar en el menú (ADR 0117):
  // un enlace guardado a la pestaña de antes lleva allí.
  beforeLoad: ({ search }) => {
    if (search.tab === "formularios") throw redirect({ to: "/settings/consultation-forms", replace: true })
  },
  pendingComponent: FormTemplatesPageSkeleton,
  component: ConsentimientosPage,
})

const TITLE = "Consentimientos"
const SUBTITLE = "Lo que firma el paciente antes de un tratamiento. La atención lo prepara solo cuando registras uno de estos servicios."

/** Los consentimientos de la clínica: ya vienen activos. Las fichas del equipo tienen su propio lugar. */
function ConsentimientosPage() {
  const canRead = usePermission("settings.read")
  const search = Route.useSearch()
  if (!canRead) {
    return (
      <div className="flex flex-col gap-6">
        <PageHeader title={TITLE} subtitle={SUBTITLE} />
        <SettingsNoAccess />
      </div>
    )
  }
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={TITLE} subtitle={search.consentimiento ? undefined : SUBTITLE} />
      {search.consentimiento ? <ConsentSheetPage consentKey={search.consentimiento} /> : <ConsentTemplatesList />}
    </div>
  )
}

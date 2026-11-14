import { PageHeader } from "@odentia/ui-patterns"
import { createFileRoute } from "@tanstack/react-router"
import { FormTemplatesPanel } from "../../components/settings/form-templates-panel"
import { SettingsNoAccess } from "../../components/settings/no-access"
import { ConsultationFormsPageSkeleton } from "../../components/skeletons/settings"
import { usePermission } from "../../lib/crm"

export const Route = createFileRoute("/_org/settings/consultation-forms")({
  pendingComponent: ConsultationFormsPageSkeleton,
  component: FichasDeConsultaPage,
})

/** El nombre del menú, de la página y de su tema en la Ayuda: `help.test.ts` los compara. */
const CONSULTATION_FORMS_TITLE = "Fichas de consulta"
const CONSULTATION_FORMS_SUBTITLE =
  "Tus hojas para anotar en consulta, además del examen. Cada una aparece sola en la atención cuando la cita es de su especialidad."

/**
 * Fichas de consulta (ADR 0117): lo que el equipo anota en la atención además
 * del examen. Las que vienen con el producto ya se usan; la clínica las mira y
 * las ajusta como las suyas.
 */
function FichasDeConsultaPage() {
  const canRead = usePermission("settings.read")
  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={CONSULTATION_FORMS_TITLE} subtitle={CONSULTATION_FORMS_SUBTITLE} />
      {canRead ? <FormTemplatesPanel /> : <SettingsNoAccess />}
    </div>
  )
}

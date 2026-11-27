import { HelpButton } from "@odentia/ui-patterns/help"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { ADMIN_NAME, useReceptionName, withReceptionName } from "../lib/agent-names"
import { apiFetch } from "../lib/api"
import { openArgos } from "../lib/argos"
import { useMyRole, useSupportMode } from "../lib/crm"
import { appWords } from "../lib/product-words"
import { GiveSupportAccess } from "./support-access"
import { casesEnvelope, SupportCasesSection } from "./support-cases"

/**
 * La Ayuda de las clínicas: el panel común de todas las apps (`HelpButton` de
 * `@odentia/ui-patterns`) con lo de la clínica: su servidor, el nombre de su
 * recepción, sus casos con soporte, Argos para las cifras y quién da acceso a soporte.
 */
export function ClinicHelpButton({ className }: { className?: string } = {}) {
  const receptionName = useReceptionName()
  const queryClient = useQueryClient()
  const myRole = useMyRole()
  // Soporte mirando la clínica no da acceso a soporte (la API lo rechaza igual).
  const supportMode = useSupportMode()
  const canGiveAccess = (myRole === "owner" || myRole === "admin") && !supportMode
  // Casos como única fuente de respuestas: el número del botón cuenta lo no leído del equipo.
  const supportCases = useQuery({
    queryKey: ["support-cases"],
    queryFn: () =>
      apiFetch("/api/help/cases").then((body: unknown) => casesEnvelope.parse(body).data),
    staleTime: 30_000,
    retry: false,
  })
  return (
    <HelpButton
      className={className}
      appName={appWords().name}
      peopleWord="pacientes"
      placeWord="clínica"
      apiBase="/api/help"
      fetcher={apiFetch}
      rename={(text) => withReceptionName(text, receptionName)}
      unseen={(supportCases.data ?? []).filter((item) => item.unread).length}
      supportMode={supportMode !== null}
      renderCases={({ initialCaseId }) => <SupportCasesSection initialCaseId={initialCaseId} />}
      renderGiveAccess={
        canGiveAccess
          ? ({ screen, onClose }) => <GiveSupportAccess screen={screen} onClose={onClose} />
          : undefined
      }
      onSent={() => void queryClient.invalidateQueries({ queryKey: ["support-cases"] })}
      dataAgent={{ name: ADMIN_NAME, ask: (question) => openArgos({ question, routed: true }) }}
    />
  )
}

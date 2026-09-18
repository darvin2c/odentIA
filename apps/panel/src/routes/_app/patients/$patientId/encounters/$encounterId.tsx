import { createFileRoute } from "@tanstack/react-router"
import { EncounterPage } from "../../../../../components/clinical/treatment"
export const Route = createFileRoute("/_app/patients/$patientId/encounters/$encounterId")({ component: Page })
function Page() { const params = Route.useParams(); return <EncounterPage patientId={params.patientId} encounterId={params.encounterId} /> }

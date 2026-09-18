import { createFileRoute } from "@tanstack/react-router"
import { TreatmentPage } from "../../../../../components/clinical/treatment"
export const Route = createFileRoute("/_app/patients/$patientId/treatments/$itemId")({ component: Page })
function Page() { const params = Route.useParams(); return <TreatmentPage patientId={params.patientId} itemId={params.itemId} /> }

import { createFileRoute } from "@tanstack/react-router"
import { PatientPage } from "../../../../components/clinical/patients"
export const Route = createFileRoute("/_app/patients/$patientId/")({ component: Page })
function Page() { const params = Route.useParams(); return <PatientPage patientId={params.patientId} /> }

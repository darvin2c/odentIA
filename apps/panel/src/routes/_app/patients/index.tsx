import { createFileRoute } from "@tanstack/react-router"
import { PatientList } from "../../../components/clinical/patients"
export const Route = createFileRoute("/_app/patients/")({ component: Page })
function Page() { return <PatientList  /> }

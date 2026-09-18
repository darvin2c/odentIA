import { createFileRoute } from "@tanstack/react-router"
import { BudgetPage } from "../../../../../components/clinical/budget"
export const Route = createFileRoute("/_app/patients/$patientId/budgets/$budgetId")({ component: Page })
function Page() { const params = Route.useParams(); return <BudgetPage patientId={params.patientId} budgetId={params.budgetId} /> }

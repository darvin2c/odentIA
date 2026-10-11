import { EmptyState, PageHeader, PageShell } from "@odentia/ui-patterns"
import { createFileRoute } from "@tanstack/react-router"
import { z } from "zod"
import { CommissionsPanel } from "../../components/finance/CommissionsPanel"
import { useMyUserId, usePermission } from "../../lib/crm"

const searchSchema = z.object({ liquidacion: z.string().optional() })

export const Route = createFileRoute("/_org/commissions")({
  validateSearch: (search) => searchSchema.parse(search),
  component: CommissionsPage,
})

function CommissionsPage() {
  const allowed = usePermission("commissions.read")
  const canWrite = usePermission("commissions.write")
  const myUserId = useMyUserId()
  const { liquidacion } = Route.useSearch()
  if (!allowed) {
    return (
      <PageShell>
        <PageHeader
          title="Comisiones"
          subtitle="Lo que le corresponde a cada profesional por lo que atendió y ya se cobró"
        />
        <EmptyState
          title="Sin acceso a comisiones"
          description="Tu rol no tiene permiso para ver comisiones. Pide a un administrador el acceso."
        />
      </PageShell>
    )
  }
  const ownOnly = !canWrite
  return (
    <PageShell>
      <PageHeader
        title={ownOnly ? "Mis comisiones" : "Comisiones"}
        subtitle="Lo que le corresponde a cada profesional por lo que atendió y ya se cobró"
      />
      <CommissionsPanel
        professionalUserId={ownOnly ? myUserId : undefined}
        ownOnly={ownOnly}
        initialSettlementId={liquidacion ?? null}
      />
    </PageShell>
  )
}

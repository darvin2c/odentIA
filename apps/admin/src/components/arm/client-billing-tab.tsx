/**
 * Ficha del cliente › Plan y pagos (ARM; solo Administración, ADR 0094): el
 * precio y la prueba negociados de siempre (`OrgBillingSection`) y los
 * comprobantes y pagos de esta clínica, con Confirmar · Rechazar en lo
 * pendiente, Reversar · Devolver en lo confirmado y Registrar pago. Son las
 * mismas operaciones de Cobros y planes (`billing-payments.tsx`); el servidor
 * se las niega a Soporte aunque llegue con el enlace.
 */
import { Button } from "@odentia/ui"
import { EmptyState, submitErrorMessage } from "@odentia/ui-patterns"
import { useQueryClient } from "@tanstack/react-query"
import { Plus } from "lucide-react"
import { useState } from "react"
import {
  ManualPaymentDrawer,
  PaymentHistoryList,
  usePaymentActions,
  usePaymentMethods,
} from "../billing-payments"
import { OrgBillingSection } from "../org-billing"
import type { ClientTabProps } from "./account-tabs"
import { invalidateClient } from "./client-model"

export function ClientBillingTab({
  clientId,
  organizationId,
  organizationName,
  isAdmin,
}: ClientTabProps) {
  if (!isAdmin)
    return (
      <EmptyState
        title="Plan y pagos es de Administración"
        description="Los importes, los comprobantes y los pagos los ve y los decide Administración."
      />
    )
  if (organizationId === null)
    return (
      <EmptyState
        title="Todavía no tiene cuenta"
        description="El plan y los pagos aparecen cuando la clínica abre su cuenta. Las condiciones que negocies antes van en la propuesta, en Venta."
      />
    )
  return (
    <ClientPayments
      clientId={clientId}
      organizationId={organizationId}
      organizationName={organizationName}
    />
  )
}

function ClientPayments({
  clientId,
  organizationId,
  organizationName,
}: {
  clientId: string
  organizationId: string
  organizationName: string
}) {
  const queryClient = useQueryClient()
  const [manualOpen, setManualOpen] = useState(false)
  const methods = usePaymentMethods()
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin", "billing"] })
    void queryClient.invalidateQueries({
      queryKey: ["admin", "organizations", organizationId, "billing"],
    })
    invalidateClient(queryClient, clientId)
  }
  const payments = usePaymentActions({ onChanged: refresh })
  /** El medio por su nombre, no por su código. */
  const methodName = (code: string) =>
    methods.data?.find((method) => method.code === code)?.name ?? code

  return (
    <div className="flex flex-col gap-6">
      <OrgBillingSection organizationId={organizationId} />

      <section aria-labelledby="pagos-clinica" className="flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <h2 id="pagos-clinica" className="text-base font-semibold">
            Comprobantes y pagos
          </h2>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={methods.isPending}
            onClick={() => setManualOpen(true)}
          >
            <Plus aria-hidden />
            Registrar pago
          </Button>
        </div>
        <p className="text-sm text-muted-foreground">
          Lo pendiente se confirma o se rechaza con un motivo que la clínica lee en su pantalla. Si
          otra persona ya lo decidió, se dice y la lista se pone al día.
        </p>
        <PaymentHistoryList
          organizationId={organizationId}
          organizationName={organizationName}
          methodName={methodName}
          actions={payments}
          confirmPending
        />
        {payments.confirm.isError ? (
          <p role="alert" className="text-sm text-destructive">
            {submitErrorMessage(payments.confirm.error)}
          </p>
        ) : null}
        {payments.actionError ? (
          <p role="alert" className="text-sm text-destructive">
            {payments.actionError}
          </p>
        ) : null}
      </section>

      {payments.dialogs}
      {manualOpen ? (
        <ManualPaymentDrawer
          orgs={[{ organizationId, organizationName }]}
          methods={methods.data ?? []}
          onClose={() => setManualOpen(false)}
          onSaved={refresh}
        />
      ) : null}
    </div>
  )
}

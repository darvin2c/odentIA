/**
 * Facturación › pedidos de negociación que esperan aprobación (ADR 0031,
 * tablero O2). WhatsApp no tiene tarifas aquí: lo cobra Meta a la clínica y
 * ella lo revisa en Meta (ADR 0085).
 */
import { Button } from "@odentia/ui"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { ApiError, api } from "../lib/api"

const errorText = (error: unknown) => (error instanceof ApiError ? (error.shape.message ?? "No se pudo guardar") : "No se pudo guardar")

interface Negotiation {
  id: string
  organizationId: string
  kind: "descuento" | "prueba"
  discountBps: number | null
  trialCreditCents: number | null
  trialDays: number | null
  note: string | null
  requestedByName: string | null
  createdAt: string
}

/** Lo que alguien pidió fuera de lo de siempre: solo la administración lo aprueba. */
export function NegotiationsSection({ organizationNames }: { organizationNames: Record<string, string> }) {
  const queryClient = useQueryClient()
  const pending = useQuery({
    queryKey: ["admin", "billing", "negotiations"],
    queryFn: () => api<Negotiation[]>("/api/admin/billing/negotiations"),
  })
  const decide = useMutation({
    mutationFn: (input: { id: string; approve: boolean }) =>
      api(`/api/admin/billing/negotiations/${input.id}/decide`, { method: "POST", body: JSON.stringify({ approve: input.approve }) }),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["admin"] }),
  })
  if (pending.isPending || pending.isError || pending.data.length === 0) return null
  return (
    <section aria-labelledby="negociaciones" className="flex flex-col gap-2">
      <h2 id="negociaciones" className="text-base font-semibold">
        Pedidos por aprobar
      </h2>
      <ul className="flex flex-col gap-2">
        {pending.data.map((item) => (
          <li key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-4 text-sm">
            <div className="min-w-0 flex-1 basis-60">
              <p className="font-medium">{organizationNames[item.organizationId] ?? item.organizationId}</p>
              <p className="text-muted-foreground">
                {item.kind === "descuento"
                  ? `Descuento de ${(item.discountBps ?? 0) / 100} % sobre el precio base`
                  : `Prueba con ${(item.trialCreditCents ?? 0) / 100} de saldo y ${item.trialDays} días`}
                {item.requestedByName ? ` · lo pide ${item.requestedByName}` : ""}
                {item.note ? ` · «${item.note}»` : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" disabled={decide.isPending} onClick={() => decide.mutate({ id: item.id, approve: true })}>
                Aprobar
              </Button>
              <Button size="sm" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate({ id: item.id, approve: false })}>
                Rechazar
              </Button>
            </div>
          </li>
        ))}
      </ul>
      {decide.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {errorText(decide.error)}
        </p>
      ) : null}
    </section>
  )
}

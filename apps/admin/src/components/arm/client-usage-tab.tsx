/**
 * Ficha del cliente › Uso (ARM): si la clínica usa lo que paga. Arriba, cómo
 * va en palabras, con las señales de riesgo que calcula el servidor (nadie
 * entra en 7 días, los mensajes de 30 días caen más de 30 %, un comprobante
 * rechazado, un caso que espera a la clínica), cada una con su hecho. Debajo,
 * el resumen del mes de siempre (`OrgSummary`) y, para Administración, los
 * gastos (`OrgSpending`). Soporte ve el resumen sin importes y la API le
 * niega lo demás.
 */
import { EmptyState, ErrorState, SkeletonRegion, submitErrorMessage } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import { AlertTriangle } from "lucide-react"
import { useState } from "react"
import { api } from "../../lib/api"
import { OrgSpending, type SpendingSearch } from "../org-spending"
import { OrgSummary } from "../org-summary"
import { ClientUsageSkeleton } from "../skeletons/client-account"
import type { ClientTabProps } from "./account-tabs"
import { clientDetailSchema, clientKey } from "./client-model"
import type { ClientTab } from "./hoy-links"
import { useOrganizationAccount } from "./organization"

const SPENDING_ID = "uso-gastos"

/** Lo que revisa cada señal, para decir qué se miró cuando no hay ninguna. */
const CHECKED =
  "Se revisa cada día si alguien de la clínica entra, si sus mensajes de 30 días bajan más de 30 %, si un caso de soporte la espera más de 3 días"

export function ClientUsageTab({ clientId, organizationId, isAdmin }: ClientTabProps) {
  const navigate = useNavigate()
  // Los gastos viven en esta pestaña: el filtro se recuerda mientras la ficha está abierta.
  const [spending, setSpending] = useState<SpendingSearch>({
    agente: "todo",
    mes: "actual",
    pagina: 1,
  })
  const detail = useQuery({
    queryKey: clientKey(clientId),
    queryFn: async () =>
      clientDetailSchema.parse(await api<unknown>(`/api/admin/clients/${clientId}`)),
  })
  const account = useOrganizationAccount(organizationId)
  const openTab = (tab: ClientTab) =>
    void navigate({
      to: ".",
      search: ((previous: Record<string, unknown>) => ({ ...previous, tab })) as never,
    })

  if (organizationId === null)
    return (
      <EmptyState
        title="Todavía no tiene cuenta"
        description="El uso se ve cuando la clínica abre su cuenta: sesiones, mensajes y lo que hicieron los agentes."
      />
    )
  if (detail.isPending || account.isPending)
    return (
      <SkeletonRegion message="Cargando el uso…">
        <ClientUsageSkeleton />
      </SkeletonRegion>
    )
  if (account.isError)
    return (
      <ErrorState
        title="No se pudo cargar la cuenta"
        message={submitErrorMessage(account.error)}
        onRetry={() => void account.refetch()}
      />
    )

  const signals = detail.data?.riskSignals ?? []
  return (
    <div className="flex flex-col gap-4">
      <section
        aria-labelledby="uso-como-va"
        className="flex flex-col gap-2 rounded-xl border bg-card p-4"
      >
        <h2 id="uso-como-va" className="text-base font-medium">
          Cómo va
        </h2>
        {detail.isError ? (
          <ErrorState
            title="No se pudieron cargar las señales"
            message={submitErrorMessage(detail.error)}
            onRetry={() => void detail.refetch()}
          />
        ) : signals.length === 0 ? (
          <p className="text-sm">
            Sin señales de riesgo hoy.{" "}
            <span className="text-muted-foreground">
              {CHECKED}
              {isAdmin ? " y si tiene un comprobante rechazado sin otro pago" : ""}.
            </span>
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {signals.map((signal) => (
              <li key={`${signal.code}-${signal.words}`} className="flex items-start gap-2 text-sm">
                <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
                <span className="[overflow-wrap:anywhere]">
                  <span className="sr-only">Señal de riesgo: </span>
                  {signal.words}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className="text-xs text-muted-foreground">
          Las cifras las calcula el sistema; Kairós solo las usa para proponer.
        </p>
      </section>

      {/* `OrgSummary` lee de la caché de la cuenta si es una demo: ya está cargada arriba. */}
      <OrgSummary
        organizationId={organizationId}
        isAdmin={isAdmin}
        members={account.data.usage.members}
        pendingInvitations={account.data.usage.pendingInvitations}
        onSpending={(agente) => {
          setSpending({ agente, mes: spending.mes, pagina: 1 })
          document.getElementById(SPENDING_ID)?.focus()
        }}
        onTeam={() => openTab("contactos")}
      />

      {isAdmin ? (
        <section
          id={SPENDING_ID}
          tabIndex={-1}
          aria-label="Gastos de la clínica"
          className="scroll-mt-4 rounded-xl outline-none focus-visible:ring-3 focus-visible:ring-ring/30"
        >
          <OrgSpending
            organizationId={organizationId}
            search={spending}
            onSearch={(next) => setSpending((current) => ({ ...current, ...next }))}
          />
        </section>
      ) : null}
    </div>
  )
}

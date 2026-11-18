/**
 * Ficha del cliente › Soporte (ARM): los casos de esta clínica que siguen
 * abiertos, con su estado y dónde está la espera, y el enlace a la cola, que
 * es donde se responden y se resuelven (`/support?clinica=`). Se pide con la
 * misma clave que la cola: lo que se responde allí se ve aquí al volver.
 * Soporte no ve los casos de cobro en ninguna pantalla.
 */
import { Badge, Button } from "@odentia/ui"
import { EmptyState, ErrorState, SkeletonRegion, submitErrorMessage } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { Link } from "@tanstack/react-router"
import { z } from "zod"
import { api } from "../../lib/api"
import { agoWords, SUPPORT_KIND_LABEL, supportDay, supportWaitWords } from "../../lib/support-words"
import { ClientSupportSkeleton } from "../skeletons/client-account"
import type { ClientTabProps } from "./account-tabs"

const STATUSES = ["abierto", "en_atencion", "esperando_clinica", "resuelto"] as const
const STATUS_LABEL: Record<(typeof STATUSES)[number], string> = {
  abierto: "Abierto",
  en_atencion: "En atención",
  esperando_clinica: "Esperando a la clínica",
  resuelto: "Resuelto",
}

const caseSchema = z.object({
  id: z.string(),
  organizationId: z.string().nullable(),
  organizationName: z.string().nullable(),
  kind: z.enum(["pregunta", "problema", "acceso", "cobro"]),
  question: z.string(),
  status: z.enum(STATUSES),
  assigneeStaffId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  waitingOnUs: z.boolean(),
  waitingSince: z.string().nullable(),
  answerBy: z.string().nullable(),
  lastStaffReplyAt: z.string().nullable(),
  accessUntil: z.string().nullable(),
})
type SupportCase = z.infer<typeof caseSchema>
const casesSchema = z.object({
  items: z.array(caseSchema),
  total: z.number(),
  resolvedCount: z.number(),
})

const PAGE = 20

/** Dónde está la espera, en una línea: la misma frase que la cola. */
function waitLine(item: SupportCase, now: Date): { text: string; urgent: boolean } {
  if (item.waitingOnUs && item.waitingSince)
    return supportWaitWords(
      { waitingSince: item.waitingSince, answerBy: item.answerBy, accessUntil: item.accessUntil },
      now,
    )
  const since = item.lastStaffReplyAt ?? item.updatedAt
  if (item.status === "esperando_clinica")
    return { text: `Espera a la clínica desde ${agoWords(since, now)}`, urgent: false }
  return { text: `Ya respondimos, ${agoWords(since, now)}`, urgent: false }
}

export function ClientSupportTab({ organizationId, isAdmin }: ClientTabProps) {
  const cases = useQuery({
    // La misma clave que la cola de Soporte con «sin resolver» y esta clínica.
    queryKey: ["admin-support-cases", "sin_resolver", null, null, organizationId, 0],
    enabled: organizationId !== null,
    queryFn: async () =>
      casesSchema.parse(
        await api<unknown>(
          `/api/admin/support/cases?${new URLSearchParams({ limit: String(PAGE), offset: "0", organizationId: organizationId ?? "" }).toString()}`,
        ),
      ),
  })

  if (organizationId === null)
    return (
      <EmptyState
        title="Todavía no tiene cuenta"
        description="Los casos de soporte llegan desde la cuenta de la clínica. Lo que pregunte antes queda en su historial."
      />
    )
  if (cases.isPending)
    return (
      <SkeletonRegion message="Cargando los casos…">
        <ClientSupportSkeleton />
      </SkeletonRegion>
    )
  if (cases.isError)
    return (
      <ErrorState
        title="No se pudieron cargar los casos"
        message={submitErrorMessage(cases.error)}
        onRetry={() => void cases.refetch()}
      />
    )

  const now = new Date()
  const items = cases.data.items.filter((item) => isAdmin || item.kind !== "cobro")
  const resolved = cases.data.resolvedCount
  return (
    <section aria-labelledby="soporte-clinica" className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id="soporte-clinica" className="text-base font-semibold">
          Casos de soporte sin resolver · {items.length}
        </h2>
        <Button
          size="sm"
          variant="outline"
          render={<Link to="/support" search={{ clinica: organizationId }} />}
        >
          Abrir en la cola
        </Button>
      </div>
      {items.length === 0 ? (
        <EmptyState
          title="Sin casos abiertos"
          description={
            resolved
              ? "No espera nada. Lo resuelto queda en la cola."
              : "No espera nada: esta clínica no tiene casos sin resolver."
          }
        />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => {
            const wait = waitLine(item, now)
            return (
              <li key={item.id}>
                <Link
                  to="/support"
                  search={{ clinica: organizationId, caso: item.id }}
                  className="flex flex-wrap items-center gap-x-4 gap-y-1.5 rounded-lg border bg-card p-4 hover:bg-muted/40 focus-visible:outline-2 focus-visible:outline-ring"
                >
                  <span className="flex min-w-0 flex-1 basis-56 flex-col gap-0.5">
                    <span className="line-clamp-2 text-sm font-medium [overflow-wrap:anywhere]">
                      {item.question}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {SUPPORT_KIND_LABEL[item.kind]} · abierto el {supportDay(item.createdAt)}
                    </span>
                    <span
                      className={
                        wait.urgent
                          ? "text-xs font-medium text-destructive"
                          : "text-xs text-muted-foreground"
                      }
                    >
                      {wait.text}
                    </span>
                  </span>
                  <Badge
                    variant={
                      item.status === "esperando_clinica"
                        ? "outline"
                        : item.waitingOnUs
                          ? "warning"
                          : "secondary"
                    }
                  >
                    {STATUS_LABEL[item.status]}
                  </Badge>
                </Link>
              </li>
            )
          })}
        </ul>
      )}
      {cases.data.total > cases.data.items.length ? (
        <p className="text-sm text-muted-foreground">
          Hay {cases.data.total} sin resolver; aquí van los {PAGE} primeros. Los demás, en la cola.
        </p>
      ) : null}
      {resolved > 0 ? (
        <Link
          to="/support"
          search={{ clinica: organizationId, estado: "resuelto" }}
          className="self-start text-sm underline underline-offset-4"
        >
          Ver {resolved === 1 ? "el caso resuelto" : `los ${resolved} resueltos`}
        </Link>
      ) : null}
    </section>
  )
}

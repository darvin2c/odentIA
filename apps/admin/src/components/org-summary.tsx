/**
 * Ficha de la clínica › Resumen (lienzo «Gastos por organización», tablero
 * 1): cómo va el mes en una mirada. La administración ve lo que paga, lo que
 * nos costó, el margen y el crédito; soporte solo cuántas cosas hicieron los
 * agentes, sin importes (decisión D4, ADR 0094).
 */
import { Button } from "@odentia/ui"
import { ErrorState, LoadingState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { api } from "../lib/api"
import { cost, money, plural } from "../lib/cost-format"
import type { ClinicCostMargin } from "./cost-margin"
import type { SpendingAgent } from "./org-spending"

interface AgentCounts {
  period: { start: string; end: string; credit: "prueba" | "mes" }
  sofi: { conversations: number; byTier: Record<"informa" | "gestiona" | "agenda", number> }
  clio: { consultations: number; byTier: Record<"simple" | "estandar" | "completa", number> }
  argos: { questions: number; included: number; limited: boolean; recovered: number }
}

/** Lo que usa el Resumen de `/organizations/:id/billing` (solo administración). */
export interface BillingSummary {
  plan: { name: string; currency: string } | null
  status: string
  billingCycle: "mensual" | "quincenal"
  halfCycleDays: number
  seller: { name: string } | null
  consumption: {
    currency: string | null
    priced: boolean
    subtotalCents: number
    creditCents: number
    period: { credit: "prueba" | "mes" }
  }
  notices: Array<{ kind: string; sentAt: string | null }>
}

const NOTICE_WORDS: Record<string, string> = {
  saldo_prueba_aviso: "Le queda poco saldo de prueba",
  saldo_prueba_alarma: "Casi sin saldo de prueba",
  saldo_prueba_limite: "Agentes en pausa por saldo",
  dias_prueba_aviso: "La prueba termina pronto",
  dias_prueba_alarma: "La prueba termina en 2 días",
  credito_aviso: "Va por la mitad de su crédito",
  credito_alarma: "Casi usa todo su crédito",
  credito_limite: "Usaste todo tu crédito",
  tope_aviso: "Aviso de tope",
  tope_alarma: "Alarma de tope",
  tope_limite: "Tope alcanzado",
  prueba_vencida_sin_plan: "Prueba terminada sin plan",
  gracia_inicio: "Inicio de gracia",
  restriccion_inicio: "Acceso restringido",
  precio_especial_aviso: "Su precio especial termina",
  precio_especial_alarma: "Su precio especial termina en 3 días",
  condiciones_aviso: "Sus condiciones de Fundador terminan",
  condiciones_alarma: "Sus condiciones de Fundador terminan en 7 días",
}

const longDay = (iso: string) =>
  new Intl.DateTimeFormat("es-PE", { day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(iso),
  )
const lastDay = (iso: string) => longDay(new Date(new Date(iso).getTime() - 1).toISOString())

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-xl border bg-card p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="text-xl font-semibold tabular-nums">{value}</p>
      {detail ? <p className="text-xs text-muted-foreground">{detail}</p> : null}
    </div>
  )
}

/**
 * El crédito del mes en gris: usarlo entero es lo normal (lo que pasa se suma
 * a la factura), así que no se pinta de rojo. El rojo queda para la alarma.
 */
function CreditBar({ billing }: { billing: BillingSummary }) {
  const { subtotalCents, creditCents, period } = billing.consumption
  const currency = billing.consumption.currency ?? billing.plan?.currency ?? "USD"
  const trial = period.credit === "prueba"
  const inside = Math.min(subtotalCents, creditCents)
  const over = Math.max(0, subtotalCents - creditCents)
  const whole = Math.max(subtotalCents, creditCents, 1)
  const name = trial ? "Saldo de prueba" : "Crédito del mes"
  const state =
    inside >= creditCents ? "usado entero" : `quedan ${money(creditCents - inside, currency)}`
  const said =
    over > 0 && !trial
      ? `${money(inside, currency)} de ${money(creditCents, currency)} · ${money(over, currency)} más en la factura`
      : `${money(inside, currency)} de ${money(creditCents, currency)}`
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap justify-between gap-2 text-sm">
        <span>
          <b>{name}</b> · {state}
        </span>
        <span className="tabular-nums text-muted-foreground">{said}</span>
      </div>
      <div
        className="flex h-2.5 overflow-hidden rounded-full bg-muted"
        role="img"
        aria-label={`${name}: ${said}`}
      >
        <span className="bg-foreground/75" style={{ flex: `0 0 ${(inside / whole) * 100}%` }} />
        {over > 0 ? (
          <span
            className="bg-muted-foreground/45"
            style={{ flex: `0 0 ${(over / whole) * 100}%` }}
          />
        ) : null}
      </div>
      {over > 0 && !trial ? (
        <div className="flex flex-wrap gap-4 text-xs text-muted-foreground">
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-foreground/75" aria-hidden /> Dentro del crédito
          </span>
          <span className="flex items-center gap-1.5">
            <span className="size-2.5 rounded-sm bg-muted-foreground/45" aria-hidden /> Sobre el
            crédito
          </span>
        </div>
      ) : null}
    </div>
  )
}

function AgentCard({
  name,
  amount,
  headline,
  lines,
  costText,
  link,
  onOpen,
}: {
  name: string
  amount: string | null
  headline: string
  lines: Array<[string, number]>
  costText: string | null
  link: string
  onOpen: (() => void) | null
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border bg-card p-3.5">
      <div className="flex items-baseline justify-between gap-2">
        <b className="text-base">{name}</b>
        {amount ? <span className="font-semibold tabular-nums">{amount}</span> : null}
      </div>
      <p className="text-sm">{headline}</p>
      {lines.map(([label, value]) => (
        <div key={label} className="flex justify-between gap-2 text-sm text-muted-foreground">
          <span>{label}</span>
          <span className="tabular-nums">{value}</span>
        </div>
      ))}
      {costText ? (
        <div className="flex justify-between gap-2 border-t pt-2 text-sm">
          <span className="text-muted-foreground">Nos costó</span>
          <span className="tabular-nums">{costText}</span>
        </div>
      ) : null}
      {onOpen ? (
        <Button
          type="button"
          variant="link"
          size="sm"
          className="h-auto self-start p-0"
          onClick={onOpen}
        >
          {link}
        </Button>
      ) : null}
    </div>
  )
}

export function OrgSummary({
  organizationId,
  isAdmin,
  members,
  pendingInvitations,
  onSpending,
  onTeam,
}: {
  organizationId: string
  isAdmin: boolean
  members: number
  pendingInvitations: number
  onSpending: (agent: SpendingAgent) => void
  onTeam: () => void
}) {
  const counts = useQuery({
    queryKey: ["admin", "organizations", organizationId, "agents"],
    queryFn: () => api<AgentCounts>(`/api/admin/organizations/${organizationId}/agents`),
  })
  const margin = useQuery({
    queryKey: ["admin", "cost-margin", organizationId, "actual"],
    enabled: isAdmin,
    queryFn: () =>
      api<ClinicCostMargin>(`/api/admin/billing/cost-margin/${organizationId}?periodo=actual`),
  })
  const billing = useQuery({
    queryKey: ["admin", "organizations", organizationId, "billing"],
    enabled: isAdmin,
    queryFn: () => api<BillingSummary | null>(`/api/admin/organizations/${organizationId}/billing`),
  })

  if (counts.isPending || (isAdmin && (margin.isPending || billing.isPending)))
    return <LoadingState message="Cargando el resumen…" />
  if (counts.isError)
    return <ErrorState title="No se pudo cargar el resumen" onRetry={() => void counts.refetch()} />
  if (isAdmin && margin.isError)
    return <ErrorState title="No se pudo cargar el costo" onRetry={() => void margin.refetch()} />
  const c = counts.data
  const m = isAdmin ? margin.data : undefined
  const b = isAdmin ? (billing.data ?? null) : null
  const currency = m?.currency ?? "USD"
  const sum = (group: string, field: "chargedCents" | "costMicros") =>
    (m?.lines ?? [])
      .filter((line) => line.group === group || line.key === `${group}:sin_cobro`)
      .reduce((total, line) => total + line[field], 0)
  const argosCost = (m?.lines ?? [])
    .filter((line) => line.group === "argos" || line.key.startsWith("argos:"))
    .reduce((total, line) => total + line.costMicros, 0)
  const freeCost = (m?.lines ?? [])
    .filter((line) => ["jev", "pruebas", "soporte"].includes(line.key))
    .reduce((total, line) => total + line.costMicros, 0)
  const lastNotice = b?.notices
    .filter((notice) => notice.sentAt)
    .sort((x, y) => (y.sentAt ?? "").localeCompare(x.sentAt ?? ""))[0]
  const trial = c.period.credit === "prueba"
  const today = new Date()
  const days = Math.max(
    1,
    Math.ceil((today.getTime() - new Date(c.period.start).getTime()) / 86_400_000),
  )
  const subtotal = b?.consumption.subtotalCents ?? 0
  const over = Math.max(0, subtotal - (b?.consumption.creditCents ?? 0))

  return (
    <div className="flex flex-col gap-4">
      <section
        className="flex flex-col gap-3.5 rounded-xl border bg-card p-4"
        aria-labelledby="mes"
      >
        <div className="flex flex-wrap items-end justify-between gap-2">
          <div>
            <h2 id="mes" className="text-base font-medium">
              {trial ? "La prueba, en curso" : "El mes, en curso"}
            </h2>
            <p className="text-xs text-muted-foreground">
              Del {longDay(c.period.start)} al {lastDay(c.period.end)} · van{" "}
              {plural(days, "día", "días")}
              {trial ? "" : ` · se factura el ${longDay(c.period.end)}`}
            </p>
          </div>
          {isAdmin ? (
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => onSpending("todo")}
            >
              Ver los gastos →
            </Button>
          ) : null}
        </div>
        {m ? (
          <div className="grid gap-2 sm:grid-cols-3">
            <Stat
              label="Lo que paga, sin impuestos"
              value={money(m.chargedCents, currency)}
              detail={
                trial
                  ? "La prueba es de regalo"
                  : over > 0
                    ? `Cuota y ${money(over, currency)} sobre el crédito`
                    : "Solo la cuota: el crédito alcanzó"
              }
            />
            <Stat
              label="Nos costó"
              value={cost(m.costMicros, currency)}
              detail={`IA ${cost(m.aiMicros)} · espacio ${cost(m.storageMicros)} · servidor ${cost(m.fixedMicros)}`}
            />
            <Stat
              label="Margen"
              value={m.marginPct === null ? "Sin cobro" : `${m.marginPct} %`}
              detail={`${m.sellerName ? `Con la comisión: ${m.marginAfterCommissionPct ?? "—"} %` : "Sin vendedor: no hay comisión"} · ${m.alarm ? "para revisar" : "sin alarma"}`}
            />
          </div>
        ) : null}
        {b?.consumption.priced ? <CreditBar billing={b} /> : null}
        {!isAdmin ? (
          <p className="text-xs text-muted-foreground">Los importes los ve la administración.</p>
        ) : null}
      </section>

      <section className="flex flex-col gap-2.5" aria-labelledby="agentes">
        <h2 id="agentes" className="text-base font-medium">
          Lo que hicieron los agentes
        </h2>
        <div className="grid gap-2.5 md:grid-cols-3">
          <AgentCard
            name="Sofi"
            amount={m ? money(sum("sofi", "chargedCents"), currency) : null}
            headline={plural(c.sofi.conversations, "conversación", "conversaciones")}
            lines={[
              ["Informa", c.sofi.byTier.informa],
              ["Gestiona", c.sofi.byTier.gestiona],
              ["Subieron a Agenda", c.sofi.byTier.agenda],
            ]}
            costText={m ? cost(sum("sofi", "costMicros")) : null}
            link="Ver las conversaciones"
            onOpen={isAdmin ? () => onSpending("sofi") : null}
          />
          <AgentCard
            name="Clío"
            amount={m ? money(sum("clio", "chargedCents"), currency) : null}
            headline={plural(c.clio.consultations, "atención dictada", "atenciones dictadas")}
            lines={[
              ["Simple", c.clio.byTier.simple],
              ["Estándar", c.clio.byTier.estandar],
              ["Completa", c.clio.byTier.completa],
            ]}
            costText={m ? cost(sum("clio", "costMicros")) : null}
            link="Ver las atenciones"
            onOpen={isAdmin ? () => onSpending("clio") : null}
          />
          <AgentCard
            name="Argos"
            amount={m ? money(sum("argos", "chargedCents"), currency) : null}
            headline={`${plural(c.argos.questions, "pregunta", "preguntas")} y ${plural(c.argos.recovered, "cita recuperada", "citas recuperadas")}`}
            lines={[
              [
                c.argos.limited ? `Preguntas, de ${c.argos.included} incluidas` : "Preguntas",
                c.argos.questions,
              ],
              ["Citas recuperadas", c.argos.recovered],
            ]}
            costText={m ? cost(argosCost) : null}
            link="Ver las preguntas"
            onOpen={isAdmin ? () => onSpending("argos") : null}
          />
        </div>
        {m ? (
          <p className="text-xs text-muted-foreground">
            Además, lo que no se cobra (Jev, pruebas, notas de voz y vectores) nos costó{" "}
            {cost(freeCost)}. Está en «Gastos».
          </p>
        ) : null}
      </section>

      <section
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-card p-4 text-sm"
        aria-label="Equipo y avisos"
      >
        <p>
          <b>Equipo:</b> {plural(members, "miembro", "miembros")},{" "}
          {pendingInvitations
            ? plural(pendingInvitations, "invitación pendiente", "invitaciones pendientes")
            : "sin invitaciones pendientes"}
          .{" "}
          <Button type="button" variant="link" size="sm" className="h-auto p-0" onClick={onTeam}>
            Ver equipo
          </Button>
        </p>
        {isAdmin ? (
          <p>
            <b>Último aviso:</b>{" "}
            {lastNotice?.sentAt
              ? `«${NOTICE_WORDS[lastNotice.kind] ?? lastNotice.kind}», el ${longDay(lastNotice.sentAt)}.`
              : "ninguno este mes."}
          </p>
        ) : null}
      </section>
    </div>
  )
}

import { cn } from "@odentia/ui"
import { Link } from "@tanstack/react-router"
import { ArrowRight, ChevronRight } from "lucide-react"
import { useReceptionName } from "../../lib/agent-names"
import { weekSummary } from "../../lib/branch-hours"
import { dayLabel, type KnowledgeSources as Sources } from "./knowledge-model"

function plural(total: number, one: string, many: string): string {
  return total === 1 ? `1 ${one}` : `${total} ${many}`
}

/** «Efectivo, Yape y tarjeta». */
function listed(names: string[]): string {
  return names.length > 1 ? `${names.slice(0, -1).join(", ")} y ${names[names.length - 1]}` : (names[0] ?? "")
}

type Destination =
  | "/settings/availability"
  | "/settings/branches"
  | "/settings/team"
  | "/services"
  | "/services/promotions"
  | "/settings/payment-methods"
  | "/settings"

interface Row {
  to: Destination
  title: string
  detail: string
  action: string
  /** Falta algo que el agente necesita: la fila lo dice en ámbar. */
  warn?: boolean
}

/** Cuántos días adelante se avisan los cierres de una sede (`CLOSURE_DAYS` de los servicios). */
const CLOSURE_DAYS = 14

function rows(sources: Sources, receptionName: string): Row[] {
  const off = "No le llega: «Informar» está apagado"
  const withHours = sources.hours.filter((branch) => branch.week.length > 0)
  const closures = sources.hours.reduce((total, branch) => total + branch.closures.length, 0)
  const { branches, team, services, promotions } = sources
  const missingAddress = branches.total - branches.withAddress
  const missingPhone = branches.total - branches.withPhone
  const [promotion] = promotions
  return [
    {
      to: "/settings/availability",
      title: "Horario de atención",
      detail: withHours.length
        ? withHours.map((branch) => `${sources.hours.length > 1 ? `${branch.name}: ` : ""}${weekSummary(branch.week)}`).join(" · ")
        : `Nadie del equipo tiene horario: ${receptionName} no dice días ni horas`,
      action: "Horarios y ausencias",
      warn: withHours.length === 0,
    },
    {
      to: "/settings/availability",
      title: "Feriados y cierres",
      detail: closures === 0 ? `Ninguno en los próximos ${CLOSURE_DAYS} días` : `${plural(closures, "cierre", "cierres")} en los próximos ${CLOSURE_DAYS} días`,
      action: "Horarios y ausencias",
    },
    {
      to: "/settings/branches",
      title: "Sedes",
      detail:
        branches.total === 0
          ? "Ninguna sede activa"
          : missingAddress > 0
            ? `${plural(branches.total, "sede", "sedes")} · ${plural(missingAddress, "sin dirección", "sin dirección")}: no puede decir cómo llegar`
            : `${plural(branches.total, "sede", "sedes")} con dirección y cómo llegar${missingPhone === 0 ? ", y teléfono" : ` · ${plural(missingPhone, "sin teléfono", "sin teléfono")}`}`,
      action: "Sedes",
      warn: branches.total === 0 || missingAddress > 0,
    },
    {
      to: "/settings/team",
      title: "Equipo",
      detail: !sources.informs
        ? off
        : team.professionals === 0
          ? "Nadie con horario todavía"
          : `${plural(team.professionals, "profesional", "profesionales")}${team.specialties ? ` en ${plural(team.specialties, "especialidad", "especialidades")}` : ""}, con los días que atiende cada uno`,
      action: "Equipo",
    },
    {
      to: "/services",
      title: "Servicios y precios",
      detail:
        services.total === 0
          ? "Ningún servicio activo"
          : !sources.informs
            ? `${plural(services.total, "servicio", "servicios")}, solo para agendar: sin precios porque «Informar» está apagado`
            : `${plural(services.total, "servicio", "servicios")} · ${services.priced === 0 ? `ningún precio que ${receptionName} pueda decir` : `${services.priced} con precio que dice ${receptionName}`}`,
      action: "Servicios",
      warn: services.total === 0,
    },
    {
      to: "/services/promotions",
      title: "Promociones",
      detail: !sources.informs
        ? off
        : promotions.length === 0
          ? "Ninguna vigente"
          : promotions.length === 1 && promotion
            ? `1 vigente: ${promotion.name}${promotion.endsAt ? `, hasta el ${dayLabel(promotion.endsAt.slice(0, 10))}` : ""}`
            : `${promotions.length} vigentes`,
      action: "Promociones",
    },
    {
      to: "/settings/payment-methods",
      title: "Medios de pago",
      detail: !sources.informs ? off : sources.paymentMethods.length ? listed(sources.paymentMethods) : "Ninguno activo",
      action: "Medios de pago",
    },
    {
      to: "/settings",
      title: "Teléfono de urgencias",
      detail: sources.emergencyPhone
        ? "Lo da ante una urgencia, junto al número de emergencias del país"
        : `Falta: ante una urgencia, ${receptionName} solo puede indicar ir a emergencias`,
      action: sources.emergencyPhone ? "Datos de la clínica" : "Agregarlo",
      warn: !sources.emergencyPhone,
    },
  ]
}

/**
 * «Lo que toma de tus datos» (ADR 0119): todo lo que el agente lee del sistema
 * en el momento, con cuánto hay y dónde se edita. Sale de las mismas fuentes
 * que su prompt (`/api/agent/knowledge/sources`), así lo que dice la pantalla
 * es lo que recibe. Lo que falta y necesita va en ámbar, con su texto: no solo
 * con color.
 */
export function KnowledgeSources({ sources }: { sources: Sources | null }) {
  const receptionName = useReceptionName()
  return (
    <section aria-labelledby="tus-datos" className="elevated flex min-w-0 flex-col overflow-hidden rounded-xl border bg-card">
      <div className="px-4 pt-4 pb-2.5 sm:px-6">
        <h2 id="tus-datos" className="font-heading text-base font-semibold">
          Lo que toma de tus datos
        </h2>
        <p className="text-sm text-muted-foreground">Siempre al día: no se copia, se lee en el momento. Se edita donde vive.</p>
      </div>
      {sources ? (
        <ul className="flex flex-col">
          {rows(sources, receptionName).map((row) => (
            <li key={row.title} className="border-t">
              <Link
                to={row.to}
                className={cn(
                  "grid min-h-14 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 px-4 py-2.5 outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset sm:grid-cols-[13rem_minmax(0,1fr)_auto] sm:px-6",
                  row.warn && "bg-warning-soft text-warning hover:bg-warning-soft/80",
                )}
              >
                <span className="font-semibold">{row.title}</span>
                <ChevronRight aria-hidden className={cn("size-4 sm:hidden", row.warn ? "text-warning" : "text-primary")} />
                <span className={cn("col-span-2 text-sm [overflow-wrap:anywhere] sm:col-span-1", !row.warn && "text-muted-foreground")}>
                  {row.detail}
                </span>
                <span className={cn("hidden items-center gap-1.5 text-sm font-semibold sm:inline-flex", row.warn ? "text-warning" : "text-primary")}>
                  {row.action}
                  <ArrowRight aria-hidden className="size-3.5" />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="border-t bg-muted/60 px-4 py-3 text-sm text-muted-foreground sm:px-6">
        De cada persona, solo mientras le escribe: sus citas, su presupuesto, su saldo y lo que la clínica anotó de ella. Nada de su historia
        clínica.
      </p>
    </section>
  )
}

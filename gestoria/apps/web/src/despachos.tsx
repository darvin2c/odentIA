import {
  Badge,
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@odentia/ui"
import { EmptyState, ErrorState } from "@odentia/ui-patterns"
import { useQuery } from "@tanstack/react-query"
import { useNavigate } from "@tanstack/react-router"
import {
  CalendarClock,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MessageCircle,
  PackageCheck,
  Truck,
} from "lucide-react"
import { type ReactNode, useId, useState } from "react"
import { type DeliveryStep, DeliveryStepDialog } from "./entregas"
import { api } from "./lib/api"
import {
  byCourier,
  type CourierFilter,
  chargeOf,
  courierCounts,
  type Delivery,
  DISPATCH_KEY,
  type DispatchBoard,
  dayCountText,
  sections,
  wayText,
} from "./lib/despachos"
import { dayName, nextDay, storeToday } from "./lib/pedidos"
import { money } from "./lib/tienda"
import { agencySite } from "./lib/zonas"
import { StoreHeader, useStoreContext } from "./tiendas"

/**
 * Despachos (entrega 3 del lienzo «gestorIA como odentIA», tablero 6): qué sale, cuándo y quién lo
 * lleva, como la Agenda de odentIA pero con la entrega. Arriba, los días con cuántas entregas hay;
 * sin rejilla por horas, porque una entrega no tiene hora exacta. Primero lo que no se entregó, con
 * su motivo y lo que hay que cobrar; después cada franja y «Sin franja». La forma de entrega va en
 * la fila. «Pasar a…» es la única forma de mover una entrega: con teclado y en el celular.
 *
 * Cada botón es la operación del pedido (`entregas.tsx`), la misma de Pedidos. «Cobrar» es el
 * saldo único del pedido: lo mismo que dicen el pedido, Caja y Reportes.
 */

function previousDay(day: string): string {
  const date = new Date(`${day}T12:00:00Z`)
  date.setUTCDate(date.getUTCDate() - 1)
  return date.toISOString().slice(0, 10)
}

export function DispatchPage() {
  const { store } = useStoreContext()
  const [day, setDay] = useState<string | null>(null)
  const [filter, setFilter] = useState<CourierFilter>("todos")
  const board = useQuery({
    queryKey: [...DISPATCH_KEY(store.id), day ?? "hoy"],
    queryFn: () =>
      api<DispatchBoard>(`/api/tiendas/${store.id}/despachos${day ? `?dia=${day}` : ""}`),
    refetchInterval: 60_000,
  })
  const today = board.data?.today ?? storeToday(store.timeZone)
  const chosen = board.data?.day ?? day ?? today
  const deliveries = board.data?.deliveries ?? []
  const counts = courierCounts(deliveries)
  // Un repartidor que ya no tiene entregas ese día deja de filtrar.
  const active =
    filter === "todos" ||
    (filter === "sin" ? counts.without > 0 : counts.couriers.some((c) => c.id === filter))
      ? filter
      : "todos"
  const shown = byCourier(deliveries, active)
  const groups = sections(shown)
  const summary = board.data?.days.find((d) => d.day === chosen)

  return (
    <>
      <StoreHeader title="Despachos" subtitle="Qué sale, cuándo y quién lo lleva." />
      <nav aria-label="Días de entrega" className="flex items-stretch gap-2">
        <Button
          variant="outline"
          size="icon"
          aria-label="Día anterior"
          onClick={() => setDay(previousDay(chosen))}
        >
          <ChevronLeft aria-hidden />
        </Button>
        {/* En el celular, el día elegido; en pantallas anchas, los siete días. */}
        <p className="flex flex-1 flex-col justify-center rounded-lg border px-3 py-1.5 text-sm sm:hidden">
          <span className="font-semibold">
            {dayName(chosen, today)}
            {/* «mañana» y «ayer» no dicen el número; los demás días ya lo traen. */}
            {["mañana", "ayer"].includes(dayName(chosen, today))
              ? ` · ${Number(chosen.slice(8))}`
              : ""}
          </span>
          {summary ? (
            <span className="text-xs text-muted-foreground">{dayCountText(summary, today)}</span>
          ) : null}
        </p>
        <ol className="hidden flex-1 grid-cols-7 gap-2 sm:grid">
          {(board.data?.days ?? []).map((d) => (
            <li key={d.day}>
              <button
                type="button"
                aria-pressed={d.day === chosen}
                onClick={() => setDay(d.day === today ? null : d.day)}
                className={`flex h-full w-full flex-col rounded-lg border px-2 py-1.5 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 ${
                  d.day === chosen ? "border-primary bg-primary-soft" : "hover:bg-surface-muted"
                }`}
              >
                <span className="font-semibold">
                  {dayName(d.day, today) === "hoy"
                    ? "hoy"
                    : new Intl.DateTimeFormat("es-PE", {
                        weekday: "short",
                        day: "numeric",
                        timeZone: "UTC",
                      }).format(new Date(`${d.day}T12:00:00Z`))}
                </span>
                <span className="text-xs text-muted-foreground">{dayCountText(d, today)}</span>
              </button>
            </li>
          ))}
        </ol>
        <Button
          variant="outline"
          size="icon"
          aria-label="Día siguiente"
          onClick={() => setDay(nextDay(chosen))}
        >
          <ChevronRight aria-hidden />
        </Button>
      </nav>
      {chosen !== today ? (
        <Button variant="ghost" className="w-fit" onClick={() => setDay(null)}>
          Volver a hoy
        </Button>
      ) : null}

      {deliveries.length > 0 ? (
        <fieldset className="m-0 flex flex-wrap gap-2 border-0 p-0">
          <legend className="sr-only">Repartidor</legend>
          <FilterButton active={active === "todos"} onClick={() => setFilter("todos")}>
            Todos
          </FilterButton>
          {counts.couriers.map((c) => (
            <FilterButton key={c.id} active={active === c.id} onClick={() => setFilter(c.id)}>
              {c.name} · {c.count}
            </FilterButton>
          ))}
          {counts.without > 0 ? (
            <FilterButton active={active === "sin"} onClick={() => setFilter("sin")}>
              Sin repartidor · {counts.without}
            </FilterButton>
          ) : null}
        </fieldset>
      ) : null}

      {board.isPending ? <p className="text-sm text-muted-foreground">Cargando entregas…</p> : null}
      {board.isError ? (
        <ErrorState error={board.error} onRetry={() => void board.refetch()} />
      ) : null}
      {board.data && deliveries.length === 0 ? (
        <EmptyState
          icon={Truck}
          title={chosen === today ? "Nada para entregar hoy" : "Nada para entregar ese día"}
          description="Los pedidos listos para salir aparecen aquí, en su día. Un pedido sin franja sale igual."
        />
      ) : null}
      {groups.map((group) => (
        <Section
          key={group.key}
          title={group.title}
          missed={group.missed}
          count={group.deliveries.length}
        >
          {group.deliveries.map((d) => (
            <DeliveryRow key={d.id} delivery={d} today={today} />
          ))}
        </Section>
      ))}
    </>
  )
}

function FilterButton({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Button
      type="button"
      size="sm"
      variant={active ? "default" : "outline"}
      aria-pressed={active}
      className="rounded-full"
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

function Section({
  title,
  missed,
  count,
  children,
}: {
  title: string
  missed: boolean
  count: number
  children: ReactNode
}) {
  const id = useId()
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h2 id={id} className={`text-sm font-semibold ${missed ? "text-warning" : ""}`}>
        {title} ({count})
      </h2>
      <ul
        className={`elevated flex flex-col divide-y overflow-hidden rounded-xl border bg-card ${missed ? "border-warning/40" : ""}`}
      >
        {children}
      </ul>
    </section>
  )
}

/** Lo primero que toca con esa entrega, en un toque. */
function primaryStep(d: Delivery): { step: DeliveryStep; label: string } | null {
  const due = d.balance.dueCents
  if (d.state === "entregado") return null
  if (d.missed && !d.missed.resolved) return { step: "pasar", label: "Pasar a…" }
  if (d.state === "por_salir" && d.deliveryType !== "OnSitePickup")
    return { step: "salio", label: "Salió" }
  return { step: "entregado", label: due > 0 ? `Cobrar y entregar` : "Entregado" }
}

function DeliveryRow({ delivery: d, today }: { delivery: Delivery; today: string }) {
  const { store } = useStoreContext()
  const navigate = useNavigate()
  const [step, setStep] = useState<DeliveryStep | null>(null)
  const charge = chargeOf(d.balance)
  const primary = primaryStep(d)
  const open = d.state === "por_salir" || d.state === "en_camino"
  const pickup = d.deliveryType === "OnSitePickup"
  const parcel = d.deliveryType === "ParcelService"
  const cur = store.currency
  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-4">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="truncate font-semibold">
          <span className="font-mono font-normal text-muted-foreground">{d.number} · </span>
          {d.customerName}
        </span>
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted-foreground">
          <span>{wayText(d)}</span>
          {parcel && d.agency && d.tracking ? (
            agencySite(d.agency) ? (
              <a
                className="underline"
                href={agencySite(d.agency) ?? ""}
                target="_blank"
                rel="noopener noreferrer"
                aria-label={`N.º ${d.tracking}: seguir en la web de ${d.agency}`}
              >
                N.º {d.tracking}
              </a>
            ) : (
              <span>N.º {d.tracking}</span>
            )
          ) : null}
          {parcel && d.state === "en_camino" && !d.tracking ? <span>sin n.º de envío</span> : null}
          {!pickup ? <span>{d.courierName ?? "Sin repartidor"}</span> : null}
          {d.late && d.deliverOn ? (
            <Badge variant="warning">Salía {dayName(d.deliverOn, today)}</Badge>
          ) : null}
          {d.deliverOn === null && open ? <Badge variant="outline">Sin día</Badge> : null}
        </span>
        {d.missed ? (
          <span className="text-sm text-warning">
            {d.missed.resolved ? "No se entregó ese día" : "No se entregó"}
            {d.missed.reason ? ` · ${d.missed.reason}` : ""}
            {d.missed.resolved || !d.deliverOn ? "" : ` · va ${dayName(d.deliverOn, today)}`}
          </span>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {d.state === "entregado" ? (
          <Badge variant="success">Entregado</Badge>
        ) : d.state === "en_camino" ? (
          <Badge variant="soft">En camino</Badge>
        ) : null}
        {charge.tone === "charge" ? (
          <Badge variant="warning">
            Cobrar {money(charge.cents, cur)}
            {d.balance.confirmedCents > 0 ? " · saldo" : ""}
          </Badge>
        ) : charge.tone === "pending" ? (
          <Badge variant="outline">Pago por confirmar</Badge>
        ) : (
          <Badge variant="secondary">Pagado</Badge>
        )}
        {primary ? (
          <Button size="sm" onClick={() => setStep(primary.step)}>
            {primary.step === "salio" ? (
              <Truck aria-hidden />
            ) : primary.step === "pasar" ? (
              <CalendarClock aria-hidden />
            ) : (
              <PackageCheck aria-hidden />
            )}
            {primary.label}
          </Button>
        ) : null}
        {open ? (
          <Button size="sm" variant="outline" onClick={() => setStep("avisar")}>
            <MessageCircle aria-hidden />
            Avisar
          </Button>
        ) : null}
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button size="sm" variant="ghost" aria-label={`Más acciones del pedido ${d.number}`}>
                Más
                <ChevronDown aria-hidden />
              </Button>
            }
          />
          <DropdownMenuContent align="end" className="min-w-52">
            {d.state === "por_salir" && !pickup ? (
              <DropdownMenuItem onClick={() => setStep("salio")}>Salió</DropdownMenuItem>
            ) : null}
            {open ? (
              <DropdownMenuItem onClick={() => setStep("entregado")}>
                {d.balance.dueCents > 0 ? "Cobrar y entregar" : "Entregado"}
              </DropdownMenuItem>
            ) : null}
            {open ? (
              <DropdownMenuItem onClick={() => setStep("no_entregado")}>
                No se entregó
              </DropdownMenuItem>
            ) : null}
            {d.state === "por_salir" ? (
              <DropdownMenuItem onClick={() => setStep("pasar")}>Pasar a…</DropdownMenuItem>
            ) : null}
            {open && !pickup ? (
              <DropdownMenuItem onClick={() => setStep("repartidor")}>
                Cambiar repartidor
              </DropdownMenuItem>
            ) : null}
            {open && parcel ? (
              <DropdownMenuItem onClick={() => setStep("envio")}>
                Agencia y n.º de envío
              </DropdownMenuItem>
            ) : null}
            {open ? <DropdownMenuSeparator /> : null}
            <DropdownMenuItem
              onClick={() =>
                void navigate({
                  to: "/tiendas/$id/pedidos",
                  params: { id: store.id },
                  search: { pedido: d.id },
                })
              }
            >
              Abrir el pedido
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <DeliveryStepDialog target={d} step={step} onClose={() => setStep(null)} />
    </li>
  )
}

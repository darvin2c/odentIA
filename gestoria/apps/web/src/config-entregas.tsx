import { Badge, Button, Checkbox, cn, FieldGroup, Input, toast } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import {
  ConfirmDialog,
  clockMinutes,
  EmptyState,
  ErrorState,
  FormDrawer,
  LoadingState,
  RadioChips,
  SubmitButton,
  submitErrorMessage,
  TimeSelect,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { Clock, MapPin, Package, Pencil, Plus, Search, Store, Trash2, Truck } from "lucide-react"
import { type ReactNode, useId, useMemo, useState } from "react"
import { z } from "zod"
import { MoneyInput, ToggleField } from "./campos"
import { ApiError, api } from "./lib/api"
import {
  DELIVERY_TYPES,
  type DeliveryMethod,
  type DeliveryZone,
  type Freight,
  money,
  moneyInput,
  type OpeningHours,
  type ReadyIn,
  readMoney,
  type ZoneLead,
} from "./lib/tienda"
import {
  AGENCY_SITES,
  type DeliverySetup,
  type District,
  districtsText,
  FAILED_TRIP_TEXT,
  type FailedTrip,
  hoursText,
  leadText,
  methodBody,
  READY_TEXT,
  rangeText,
  WEEKDAYS,
  type ZoneChange,
  zoneOfDistrict,
  zoneTone,
} from "./lib/zonas"
import { LimaMap } from "./mapa-lima"
import { StoreHeader, useStoreContext } from "./tiendas"

/**
 * Configuración › Entregas (lienzo «gestorIA · Configuración, de nuevo», tablero 7): la tienda
 * dice desde dónde despacha, toma la plantilla de Lima (o arma sus zonas) y ajusta precios y
 * horarios. Los distritos se eligen en el mapa o en la lista de cada zona; nadie los escribe. El
 * recojo y la agencia van en sus propias tarjetas. Las cambia quien tiene `configuracion`;
 * soporte las mira.
 */

/** Empieza como la de Cobros: guardar en una invalida las dos (y los formularios de pedido). */
const SETUP_KEY = (storeId: string) => ["pagos-y-entregas", storeId, "entregas"]
const LISTS_PREFIX = (storeId: string) => ["pagos-y-entregas", storeId]

const toClock = (minutes: number | null) =>
  minutes === null
    ? ""
    : `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`

function useRefresh(storeId: string) {
  const queryClient = useQueryClient()
  return async () => {
    await queryClient.invalidateQueries({ queryKey: LISTS_PREFIX(storeId) })
    await queryClient.invalidateQueries({ queryKey: ["configuracion-resumen", storeId] })
  }
}

/** Guarda una forma de entrega entera: nueva (POST) o la que ya está (PATCH). */
function useSaveMethod(storeId: string) {
  return useMutation({
    mutationFn: ({ id, body }: { id: string | null; body: Record<string, unknown> }) =>
      id
        ? api(`/api/tiendas/${storeId}/formas-de-entrega/${id}`, { method: "PATCH", body })
        : api(`/api/tiendas/${storeId}/formas-de-entrega`, { method: "POST", body }),
  })
}

/** Guarda una sola zona del reparto (o mueve un distrito), sobre lo guardado ahora. */
function useZoneChange(storeId: string, methodId: string) {
  return useMutation({
    mutationFn: (body: ZoneChange) =>
      api(`/api/tiendas/${storeId}/formas-de-entrega/${methodId}/zonas`, {
        method: "PATCH",
        body,
      }),
  })
}

/** Lo que cambió en otra pestaña: se vuelve a leer y se dice, sin perder lo que se ve. */
const isStale = (error: unknown) => error instanceof ApiError && error.code === "STALE"
const STALE_SEEN =
  "Esto cambió en otra pestaña o lo cambió otra persona: ya ves lo último. Vuelve a hacer tu cambio."

export function DeliveriesPage() {
  const { store } = useStoreContext()
  const canEdit = store.permissions.includes("configuracion")
  const setup = useQuery({
    queryKey: SETUP_KEY(store.id),
    queryFn: () => api<DeliverySetup>(`/api/tiendas/${store.id}/entregas`),
  })
  const data = setup.data
  const fleet = data?.deliveries.find((d) => d.type === "DeliveryModeOwnFleet") ?? null
  const pickup = data?.deliveries.find((d) => d.type === "OnSitePickup") ?? null
  const agency = data?.deliveries.find((d) => d.type === "ParcelService") ?? null
  // Con distritos, el mapa; sin ninguno (nada, un precio para todo o zonas de antes, solo con su
  // nombre), se empieza por desde dónde despacha.
  const mapped =
    fleet !== null &&
    fleet.cost === "por_zona" &&
    fleet.zones.some((zone) => zone.districts.length > 0)
  const others = data?.deliveries.filter((d) => d !== fleet && d !== pickup && d !== agency) ?? []

  return (
    <>
      <StoreHeader
        title="Entregas"
        subtitle="Cómo llega el pedido, cuánto cuesta y cuándo. Lo que apagues, Sofi deja de ofrecerlo."
      />
      {setup.isError ? (
        <ErrorState
          error={setup.error instanceof Error ? setup.error : "No se pudo cargar"}
          onRetry={() => void setup.refetch()}
        />
      ) : null}
      {setup.isPending ? (
        <Card title="Reparto">
          <LoadingState />
        </Card>
      ) : null}
      {data ? (
        <>
          {mapped ? (
            <FleetZones setup={data} fleet={fleet} canEdit={canEdit} />
          ) : (
            <FleetStart setup={data} fleet={fleet} canEdit={canEdit} />
          )}
          {mapped ? (
            <Rules setup={data} fleet={fleet} canEdit={canEdit} />
          ) : (
            <FailedTripRule setup={data} canEdit={canEdit} />
          )}
          <div className="@container">
            <div className="grid gap-6 @3xl:grid-cols-2">
              <PickupCard method={pickup} canEdit={canEdit} />
              <AgencyCard method={agency} canEdit={canEdit} />
            </div>
          </div>
          <SlotsSection storeId={store.id} slots={data.slots} canEdit={canEdit} />
          {others.length > 0 ? <OtherMethods methods={others} canEdit={canEdit} /> : null}
        </>
      ) : null}
    </>
  )
}

function Card({
  title,
  icon,
  description,
  action,
  children,
}: {
  title: string
  icon?: ReactNode
  description?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  const id = useId()
  return (
    <section
      aria-labelledby={id}
      className="elevated @container overflow-hidden rounded-xl border bg-card"
    >
      <div className="flex flex-wrap items-start justify-between gap-3 border-b px-5 py-4">
        <div className="flex min-w-0 flex-col gap-1">
          <h2 id={id} className="flex items-center gap-2 text-base font-semibold">
            {icon}
            {title}
          </h2>
          {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
        </div>
        {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

/* -------------------------------------------------------------- el comienzo del reparto */

function districtOptions(districts: District[]) {
  return districts
    .slice()
    .sort(
      (a, b) =>
        (a.province === b.province ? 0 : a.province === "Lima" ? -1 : 1) ||
        a.name.localeCompare(b.name, "es"),
    )
    .map((d) => ({ value: d.code, label: d.province === "Callao" ? `${d.name} (Callao)` : d.name }))
}

/**
 * Sin zonas: desde dónde despacha y la plantilla de Lima, o armarlas desde cero. Si ya cobraba un
 * solo precio, lo dice: la plantilla lo cambia por zonas.
 */
function FleetStart({
  setup,
  fleet,
  canEdit,
}: {
  setup: DeliverySetup
  fleet: DeliveryMethod | null
  canEdit: boolean
}) {
  const { store } = useStoreContext()
  const refresh = useRefresh(store.id)
  const save = useSaveMethod(store.id)
  const [manual, setManual] = useState(false)
  const template = useMutation({
    mutationFn: (shipFrom: string | null) =>
      api(`/api/tiendas/${store.id}/entregas/plantilla-lima`, {
        method: "POST",
        body: { shipFrom },
      }),
  })
  const form = useAppForm({
    defaultValues: { shipFrom: setup.shipFrom ?? "" },
    validators: {
      onSubmit: z.object({ shipFrom: z.string().min(1, "Elige desde qué distrito despachas") }),
    },
    onSubmit: async ({ value }) => {
      const shipFrom = value.shipFrom || null
      if (manual) {
        if (shipFrom)
          await api(`/api/tiendas/${store.id}/entregas/reglas`, {
            method: "PATCH",
            body: { shipFrom },
          })
        const zone: DeliveryZone = {
          name: "Zona 1",
          priceCents: 1000,
          districts: shipFrom ? [shipFrom] : [],
          lead: "manana",
          cutoff: null,
          weekdays: [],
          slots: [],
          payOnDelivery: true,
          freeShipping: true,
        }
        // Las zonas de antes se quedan: el distrito de la tienda entra en la primera.
        const zones =
          fleet?.cost === "por_zona" && fleet.zones.length > 0
            ? fleet.zones.map((z, i) =>
                i === 0 && shipFrom ? { ...z, districts: [...z.districts, shipFrom] } : z,
              )
            : [zone]
        await save.mutateAsync(
          fleet
            ? {
                id: fleet.id,
                body: methodBody(fleet, { cost: "por_zona", priceCents: null, zones }),
              }
            : {
                id: null,
                body: {
                  name: "Reparto propio",
                  type: "DeliveryModeOwnFleet",
                  cost: "por_zona",
                  zones: [zone],
                  acceptsPayOnDelivery: true,
                },
              },
        )
        toast.success("Listo: elige los distritos de cada zona en el mapa o en su lista")
      } else {
        await template.mutateAsync(shipFrom)
        toast.success("Plantilla de Lima lista: cambia lo que no te cuadre")
      }
      await refresh()
    },
  })
  const surface = useFormSurface(form)
  const current =
    fleet?.cost === "por_zona"
      ? fleet.zones.length > 0
        ? `Hoy «${fleet.name}» cobra por zona, sin distritos: ${fleet.zones.map((z) => `${z.name} ${money(z.priceCents, store.currency)}`).join(", ")}. La plantilla las cambia por las de Lima; armarlas tú las conserva.`
        : null
      : fleet
        ? fleet.cost === "fijo"
          ? `Hoy «${fleet.name}» cobra ${money(fleet.priceCents ?? 0, store.currency)} a cualquier distrito.`
          : fleet.cost === "gratis"
            ? `Hoy «${fleet.name}» es gratis a cualquier distrito.`
            : `Hoy «${fleet.name}» se acuerda en el chat.`
        : null

  return (
    <Card
      title="Reparto"
      icon={<Truck aria-hidden className="size-4 text-muted-foreground" />}
      description="Arma tus zonas en dos minutos: dices desde dónde despachas y partes de la plantilla de Lima, o las armas tú."
    >
      {canEdit ? (
        <form noValidate onSubmit={surface.onSubmit} className="flex flex-col gap-5 px-5 py-5">
          {current ? <p className="text-sm">{current}</p> : null}
          <div className="max-w-sm">
            <form.AppField name="shipFrom">
              {(field) => (
                <field.SelectField
                  label="¿Desde qué distrito despachas?"
                  description="De la lista oficial de distritos de Lima y el Callao."
                  placeholder="Elige el distrito"
                  options={districtOptions(setup.districts)}
                />
              )}
            </form.AppField>
          </div>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center">
            {setup.template ? (
              <SubmitButton
                type="submit"
                pending={surface.isSubmitting && !manual}
                onClick={() => setManual(false)}
              >
                Usar la plantilla de Lima
              </SubmitButton>
            ) : null}
            <SubmitButton
              type="submit"
              variant={setup.template ? "outline" : "default"}
              pending={surface.isSubmitting && manual}
              onClick={() => setManual(true)}
            >
              Prefiero armarlas yo
            </SubmitButton>
          </div>
          {setup.template ? (
            <p className="text-sm text-muted-foreground">
              La plantilla trae los 50 distritos de Lima y el Callao en 6 zonas (las de Ipsos y
              «Lejanos y playas»), con precios de partida de couriers de Lima, de S/ 10 a S/ 18.
              Después cambias lo que quieras.
            </p>
          ) : null}
          {surface.error ? (
            <p role="alert" className="text-sm text-danger">
              {surface.error}
            </p>
          ) : null}
        </form>
      ) : (
        <p className="px-5 py-4 text-sm text-muted-foreground">
          {current ?? "Todavía no hay zonas de reparto."}
        </p>
      )}
    </Card>
  )
}

/* ---------------------------------------------------------------------- las zonas */

function FleetZones({
  setup,
  fleet,
  canEdit,
}: {
  setup: DeliverySetup
  fleet: DeliveryMethod
  canEdit: boolean
}) {
  const { store } = useStoreContext()
  const refresh = useRefresh(store.id)
  const change = useZoneChange(store.id, fleet.id)
  const [editing, setEditing] = useState<number | "new" | null>(null)
  const [shipFromOpen, setShipFromOpen] = useState(false)
  const names = useMemo(
    () => new Map(setup.districts.map((d) => [d.code, d.short])),
    [setup.districts],
  )
  const zoneOf = useMemo(() => zoneOfDistrict(fleet.zones), [fleet.zones])
  const home = setup.shipFrom ? setup.districts.find((d) => d.code === setup.shipFrom) : null
  const outside = setup.districts.filter((d) => !zoneOf.has(d.code))

  const move = async (code: string, to: number | null) => {
    // Uno a la vez: el siguiente parte de lo ya guardado.
    if (change.isPending) return
    const name = names.get(code) ?? code
    const from = zoneOf.get(code)
    try {
      // Solo ese distrito, sobre lo guardado ahora: lo que cambió otra pestaña no se pisa.
      await change.mutateAsync({
        op: "distrito",
        district: code,
        from: from === undefined ? null : (fleet.zones[from]?.name ?? null),
        to: to === null ? null : (fleet.zones[to]?.name ?? null),
      })
      await refresh()
      toast.success(
        to === null
          ? `${name}: no entregas ahí`
          : `${name}: zona ${to + 1}, ${fleet.zones[to]?.name ?? ""}`,
      )
    } catch (error) {
      if (isStale(error)) {
        await refresh()
        toast.error(STALE_SEEN)
      } else toast.error(submitErrorMessage(error))
    }
  }

  return (
    <Card
      title={fleet.name}
      icon={<Truck aria-hidden className="size-4 text-muted-foreground" />}
      description={
        <>
          {home ? `Despachas desde ${home.name}. ` : null}
          Tocar un distrito en el mapa lo cambia de zona. Un distrito está en una sola zona.
        </>
      }
      action={
        <>
          <ActiveSwitch
            path={`/api/tiendas/${store.id}/formas-de-entrega/${fleet.id}`}
            storeId={store.id}
            name={fleet.name}
            active={fleet.isActive}
            canEdit={canEdit}
          />
          {canEdit ? (
            <Button variant="ghost" size="sm" onClick={() => setShipFromOpen(true)}>
              <MapPin aria-hidden />
              {home ? "Cambiar desde dónde" : "Desde dónde despachas"}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="flex flex-col gap-4 px-5 py-5">
        <ul className="flex flex-wrap gap-x-5 gap-y-2" aria-label="Zonas">
          {fleet.zones.map((zone, index) => (
            <li key={zone.name} className="flex items-center gap-2 text-sm">
              <span
                aria-hidden
                className={cn("size-4 shrink-0 rounded border-[1.5px]", zoneTone(index))}
              />
              <span className="font-medium">
                {index + 1} · {zone.name}
              </span>
              <span className="text-muted-foreground tabular-nums">{zone.districts.length}</span>
            </li>
          ))}
          <li className="flex items-center gap-2 text-sm text-muted-foreground">
            <span aria-hidden className="size-4 shrink-0 rounded border border-dashed" />
            <span>No entrego ahí</span>
            <span className="tabular-nums">{outside.length}</span>
          </li>
        </ul>
        <div className="hidden @md:block">
          <LimaMap
            districts={setup.districts}
            zoneOf={zoneOf}
            zones={fleet.zones}
            home={setup.shipFrom}
            canEdit={canEdit}
            onMove={(code, to) => void move(code, to)}
          />
          <p className="mt-2 text-xs text-muted-foreground">
            Mapa esquemático: cada cuadro es un distrito, en su lugar aproximado; no es un mapa de
            calles. Con el teclado, flechas para moverte y Enter para cambiar su zona. Las zonas
            salen de las de Lima de Ipsos; «Lejanos y playas» junta donde los couriers cobran más o
            van en días fijos.
          </p>
        </div>
      </div>
      <div className="border-t">
        <div className="hidden grid-cols-[1rem_minmax(0,1.6fr)_6rem_minmax(0,1fr)_minmax(0,1.2fr)_auto] gap-4 bg-muted/40 px-5 py-2 text-xs font-semibold tracking-wide text-muted-foreground uppercase @2xl:grid">
          <span />
          <span>Zona</span>
          <span>Precio</span>
          <span>Llega</span>
          <span>Horario de entrega</span>
          <span className="sr-only">Acciones</span>
        </div>
        <ul className="flex flex-col divide-y">
          {fleet.zones.map((zone, index) => (
            <li
              key={zone.name}
              className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1 px-5 py-3 text-sm @2xl:grid-cols-[1rem_minmax(0,1.6fr)_6rem_minmax(0,1fr)_minmax(0,1.2fr)_auto]"
            >
              <span aria-hidden className={cn("size-4 rounded border-[1.5px]", zoneTone(index))} />
              <div className="flex min-w-0 flex-col">
                <span className="font-semibold">{zone.name}</span>
                <span className="text-muted-foreground">
                  {districtsText(zone.districts, names)}
                </span>
                <span className="text-muted-foreground @2xl:hidden">
                  {leadText(zone)} · {money(zone.priceCents, store.currency)}
                </span>
              </div>
              <span className="hidden font-medium tabular-nums @2xl:block">
                {money(zone.priceCents, store.currency)}
              </span>
              <span className="hidden @2xl:block">{leadText(zone)}</span>
              <span className="hidden flex-wrap gap-1.5 @2xl:flex">
                {zone.slots.length > 0 ? (
                  zone.slots.map((slot) => (
                    <Badge key={`${slot.start}-${slot.end}`} variant="outline">
                      {rangeText(slot.start, slot.end)}
                    </Badge>
                  ))
                ) : (
                  <span className="text-muted-foreground">Sin franja</span>
                )}
              </span>
              {canEdit ? (
                <Button variant="ghost" size="sm" onClick={() => setEditing(index)}>
                  <Pencil aria-hidden />
                  <span className="@max-2xl:sr-only">Editar</span>
                  <span className="sr-only"> {zone.name}</span>
                </Button>
              ) : (
                <span />
              )}
            </li>
          ))}
        </ul>
        {canEdit ? (
          <div className="border-t px-5 py-3">
            <Button variant="outline" size="sm" onClick={() => setEditing("new")}>
              <Plus aria-hidden />
              Agregar zona
            </Button>
          </div>
        ) : null}
      </div>
      {editing !== null ? (
        <ZoneForm
          setup={setup}
          fleet={fleet}
          index={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
        />
      ) : null}
      {shipFromOpen ? <ShipFromForm setup={setup} onClose={() => setShipFromOpen(false)} /> : null}
    </Card>
  )
}

function ShipFromForm({ setup, onClose }: { setup: DeliverySetup; onClose: () => void }) {
  const { store } = useStoreContext()
  const refresh = useRefresh(store.id)
  const form = useAppForm({
    defaultValues: { shipFrom: setup.shipFrom ?? "" },
    validators: {
      onSubmit: z.object({ shipFrom: z.string().min(1, "Elige el distrito") }),
    },
    onSubmit: async ({ value }) => {
      await api(`/api/tiendas/${store.id}/entregas/reglas`, {
        method: "PATCH",
        body: { shipFrom: value.shipFrom },
      })
      await refresh()
      toast.success("Guardado")
      onClose()
    },
  })
  const surface = useFormSurface(form)
  return (
    <FormDrawer
      {...surface}
      open
      title="Desde dónde despachas"
      description="Se marca en el mapa como tu tienda. No cambia tus zonas."
      onClose={onClose}
      submitLabel="Guardar"
    >
      <form.AppField name="shipFrom">
        {(field) => (
          <field.SelectField
            label="Distrito"
            placeholder="Elige el distrito"
            options={districtOptions(setup.districts)}
          />
        )}
      </form.AppField>
    </FormDrawer>
  )
}

const LEAD_OPTIONS: { value: ZoneLead; label: string }[] = [
  { value: "hoy", label: "Hoy, con hora de corte" },
  { value: "manana", label: "Al día siguiente" },
  { value: "dias", label: "Días fijos" },
]

/**
 * Una zona: nombre, precio, cuándo llega, franjas, pago al recibir, envío gratis y sus distritos,
 * con buscador y casillas (la alternativa al mapa). Marcar uno que está en otra zona lo pasa a
 * esta: un distrito está en una sola zona.
 */
function ZoneForm({
  setup,
  fleet,
  index,
  onClose,
}: {
  setup: DeliverySetup
  fleet: DeliveryMethod
  index: number | null
  onClose: () => void
}) {
  const { store } = useStoreContext()
  const refresh = useRefresh(store.id)
  const change = useZoneChange(store.id, fleet.id)
  const zone = index === null ? null : (fleet.zones[index] ?? null)
  // La zona como estaba al abrir el cajón: si cambia en otra pestaña, guardar no la pisa.
  const [seen] = useState(zone)
  const [search, setSearch] = useState("")
  const [asking, setAsking] = useState(false)
  const zoneOf = useMemo(() => zoneOfDistrict(fleet.zones), [fleet.zones])
  const leadId = useId()
  const form = useAppForm({
    defaultValues: {
      name: zone?.name ?? `Zona ${fleet.zones.length + 1}`,
      price: moneyInput(zone?.priceCents ?? null, store.currency),
      lead: (zone?.lead ?? "manana") as ZoneLead,
      cutoff: toClock(zone?.cutoff ?? null),
      weekdays: zone?.weekdays ?? ([] as number[]),
      slots: (zone?.slots ?? []).map((s) => `${s.start}-${s.end}`),
      payOnDelivery: zone?.payOnDelivery ?? true,
      freeShipping: zone?.freeShipping ?? true,
      districts: zone?.districts ?? ([] as string[]),
    },
    validators: {
      onSubmit: z
        .object({
          name: z.string(),
          price: z.string(),
          lead: z.custom<ZoneLead>(),
          cutoff: z.string(),
          weekdays: z.array(z.number()),
          slots: z.array(z.string()),
          payOnDelivery: z.boolean(),
          freeShipping: z.boolean(),
          districts: z.array(z.string()),
        })
        .superRefine((v, ctx) => {
          if (!v.name.trim())
            ctx.addIssue({
              code: "custom",
              path: ["name"],
              message: "Escribe el nombre de la zona",
            })
          else if (
            fleet.zones.some(
              (z, i) => i !== index && z.name.toLowerCase() === v.name.trim().toLowerCase(),
            )
          )
            ctx.addIssue({
              code: "custom",
              path: ["name"],
              message: "Ya hay una zona con ese nombre",
            })
          if (readMoney(v.price, store.currency) === null)
            ctx.addIssue({
              code: "custom",
              path: ["price"],
              message: "Escribe el precio, como 10 o 12.50",
            })
          if (v.lead === "hoy" && clockMinutes(v.cutoff) === null)
            ctx.addIssue({
              code: "custom",
              path: ["cutoff"],
              message: "Elige hasta qué hora es hoy",
            })
          if (v.lead === "dias" && v.weekdays.length === 0)
            ctx.addIssue({ code: "custom", path: ["weekdays"], message: "Elige qué días vas" })
        }),
    },
    onSubmit: async ({ value }) => {
      const next: DeliveryZone = {
        name: value.name.trim(),
        priceCents: readMoney(value.price, store.currency) ?? 0,
        districts: value.districts,
        lead: value.lead,
        cutoff: value.lead === "hoy" ? clockMinutes(value.cutoff) : null,
        weekdays: value.lead === "dias" ? value.weekdays : [],
        slots: setup.slots
          .filter((s) => value.slots.includes(`${s.start}-${s.end}`))
          .map((s) => ({ start: s.start, end: s.end })),
        payOnDelivery: value.payOnDelivery,
        freeShipping: value.freeShipping,
      }
      // Solo esta zona: el servidor saca sus distritos de las demás, sobre lo guardado ahora.
      await change.mutateAsync(
        seen
          ? { op: "zona", before: seen.name, seen, zone: next }
          : { op: "zona", before: null, zone: next },
      )
      await refresh()
      toast.success(index === null ? "Zona agregada" : "Zona guardada")
      onClose()
    },
  })
  const surface = useFormSurface(form)
  const remove = useMutation({
    mutationFn: () =>
      seen ? change.mutateAsync({ op: "quitar", name: seen.name, seen }) : Promise.resolve(null),
    onSuccess: async () => {
      await refresh()
      toast.success("Zona quitada: sus distritos quedan sin entrega")
      setAsking(false)
      onClose()
    },
  })

  const query = search.trim().toLowerCase().normalize("NFD").replace(/\p{M}/gu, "")
  const shown = setup.districts.filter(
    (d) => !query || d.name.toLowerCase().normalize("NFD").replace(/\p{M}/gu, "").includes(query),
  )

  return (
    <FormDrawer
      {...surface}
      open
      title={zone ? zone.name : "Nueva zona"}
      description="Lo que cuesta, cuándo llega y a qué distritos. Sofi lo dice tal cual."
      onClose={onClose}
      submitLabel="Guardar"
    >
      <FieldGroup className="gap-5">
        <div className="grid gap-4 sm:grid-cols-[minmax(0,1fr)_9rem]">
          <form.AppField name="name">
            {(field) => <field.TextField label="Nombre" maxLength={60} />}
          </form.AppField>
          <form.AppField name="price">
            {(field) => (
              <field.Control label="Precio">
                {(control) => (
                  <MoneyInput
                    control={control}
                    currency={store.currency}
                    value={field.state.value}
                    onChange={field.handleChange}
                  />
                )}
              </field.Control>
            )}
          </form.AppField>
        </div>
        <form.AppField name="lead">
          {(field) => (
            <field.Group legend={<span id={leadId}>Llega</span>}>
              {(control) => (
                <RadioChips
                  id={control.id}
                  aria-labelledby={leadId}
                  aria-describedby={control.describedBy}
                  invalid={control.invalid}
                  onBlur={control.onBlur}
                  value={field.state.value}
                  options={LEAD_OPTIONS}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        <form.Subscribe selector={(state) => state.values.lead}>
          {(lead) =>
            lead === "hoy" ? (
              <form.AppField name="cutoff">
                {(field) => (
                  <field.Control
                    label="Hoy, si pide antes de"
                    description="En la hora de tu tienda. Después, llega al día siguiente."
                    className="max-w-48"
                  >
                    {(control) => (
                      <TimeSelect
                        id={control.id}
                        step={30}
                        value={field.state.value}
                        onChange={(next) => {
                          field.handleChange(next)
                          field.handleBlur()
                        }}
                        invalid={control.invalid}
                        aria-describedby={control.describedBy}
                        className="w-full"
                      />
                    )}
                  </field.Control>
                )}
              </form.AppField>
            ) : lead === "dias" ? (
              <form.AppField name="weekdays">
                {(field) => (
                  <field.Group legend="Qué días vas">
                    {() => (
                      <div className="flex flex-wrap gap-2">
                        {WEEKDAYS.map((day) => {
                          const on = field.state.value.includes(day.value)
                          return (
                            <Button
                              key={day.value}
                              type="button"
                              size="sm"
                              variant={on ? "default" : "outline"}
                              aria-pressed={on}
                              aria-label={day.name}
                              onClick={() =>
                                field.handleChange(
                                  on
                                    ? field.state.value.filter((d) => d !== day.value)
                                    : [...field.state.value, day.value].sort(),
                                )
                              }
                            >
                              {day.short}
                            </Button>
                          )
                        })}
                      </div>
                    )}
                  </field.Group>
                )}
              </form.AppField>
            ) : null
          }
        </form.Subscribe>
        <form.AppField name="slots">
          {(field) => (
            <field.Group
              legend="Horario de entrega"
              description={
                setup.slots.length === 0
                  ? "Todavía no hay franjas: agrégalas en «Franjas de entrega», más abajo."
                  : "Las franjas de tu tienda que valen en esta zona. Sin ninguna, sale sin franja."
              }
            >
              {() => (
                <div className="flex flex-wrap gap-2">
                  {setup.slots.map((slot) => {
                    const key = `${slot.start}-${slot.end}`
                    const on = field.state.value.includes(key)
                    return (
                      <Button
                        key={key}
                        type="button"
                        size="sm"
                        variant={on ? "default" : "outline"}
                        aria-pressed={on}
                        onClick={() =>
                          field.handleChange(
                            on
                              ? field.state.value.filter((k) => k !== key)
                              : [...field.state.value, key],
                          )
                        }
                      >
                        <Clock aria-hidden />
                        {rangeText(slot.start, slot.end)}
                      </Button>
                    )
                  })}
                </div>
              )}
            </field.Group>
          )}
        </form.AppField>
        <form.AppField name="payOnDelivery">
          {() => (
            <ToggleField
              label="Acepta pago al recibir"
              description="Apagado, Sofi pide el pago antes de enviarlo."
            />
          )}
        </form.AppField>
        <form.AppField name="freeShipping">
          {() => (
            <ToggleField
              label="Envío gratis en esta zona"
              description={
                fleet.freeFromCents
                  ? `Gratis desde ${money(fleet.freeFromCents, store.currency)}, en «Reglas».`
                  : "El monto se elige en «Reglas»."
              }
            />
          )}
        </form.AppField>
        <form.AppField name="districts">
          {(field) => (
            <field.Group
              legend={`Distritos (${field.state.value.length})`}
              description="Marcar uno que está en otra zona lo pasa a esta."
            >
              {() => (
                <div className="flex flex-col gap-2">
                  <div className="relative">
                    <Search
                      aria-hidden
                      className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground"
                    />
                    <Input
                      type="search"
                      aria-label="Buscar distrito"
                      placeholder="Buscar distrito"
                      className="pl-9"
                      value={search}
                      onChange={(event) => setSearch(event.target.value)}
                    />
                  </div>
                  <ul className="flex max-h-80 flex-col overflow-y-auto rounded-lg border">
                    {shown.map((district) => {
                      const checked = field.state.value.includes(district.code)
                      const other = zoneOf.get(district.code)
                      const elsewhere = other !== undefined && other !== index
                      const id = `distrito-${district.code}`
                      return (
                        <li key={district.code} className="border-b last:border-b-0">
                          <label
                            htmlFor={id}
                            className="flex min-h-11 cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-muted/50"
                          >
                            <Checkbox
                              id={id}
                              checked={checked}
                              onCheckedChange={(next) =>
                                field.handleChange(
                                  next
                                    ? [...field.state.value, district.code]
                                    : field.state.value.filter((c) => c !== district.code),
                                )
                              }
                            />
                            <span className="flex-1">
                              {district.name}
                              {district.province === "Callao" ? (
                                <span className="text-muted-foreground"> · Callao</span>
                              ) : null}
                            </span>
                            {elsewhere && !checked ? (
                              <span className="text-xs text-muted-foreground">
                                en {fleet.zones[other]?.name}
                              </span>
                            ) : null}
                          </label>
                        </li>
                      )
                    })}
                    {shown.length === 0 ? (
                      <li className="px-3 py-3 text-sm text-muted-foreground">
                        Ningún distrito se llama así.
                      </li>
                    ) : null}
                  </ul>
                </div>
              )}
            </field.Group>
          )}
        </form.AppField>
        {zone && fleet.zones.length > 1 ? (
          <>
            <Button
              type="button"
              variant="ghost"
              className="self-start text-danger"
              onClick={() => setAsking(true)}
            >
              <Trash2 aria-hidden />
              Quitar esta zona
            </Button>
            <ConfirmDialog
              open={asking}
              title={`¿Quitar «${zone.name}»?`}
              description={`Sus ${zone.districts.length} distritos quedan en «No entrego ahí». Los pedidos que ya tienen esta zona no cambian.`}
              confirmLabel="Quitar"
              pending={remove.isPending}
              error={remove.isError ? submitErrorMessage(remove.error) : null}
              onConfirm={() => remove.mutate()}
              onClose={() => setAsking(false)}
            />
          </>
        ) : null}
      </FieldGroup>
    </FormDrawer>
  )
}

/* ---------------------------------------------------------------------- las reglas */

/**
 * Tres reglas de la tienda, un toque cada una (tablero 7): envío gratis desde un monto (en las
 * zonas que lo tienen), quién paga el viaje si la clienta no está y en qué zonas se paga al
 * recibir. Las dos primeras de dinero se guardan con su botón; las otras, al tocar.
 */
function Rules({
  setup,
  fleet,
  canEdit,
}: {
  setup: DeliverySetup
  fleet: DeliveryMethod
  canEdit: boolean
}) {
  const { store } = useStoreContext()
  const refresh = useRefresh(store.id)
  const save = useSaveMethod(store.id)
  const zoneChange = useZoneChange(store.id, fleet.id)
  const freeId = useId()
  const free = fleet.zones.filter((z) => z.freeShipping).map((z) => z.name)
  const notFree = fleet.zones.filter((z) => !z.freeShipping).map((z) => z.name)
  const form = useAppForm({
    defaultValues: {
      mode: (fleet.freeFromCents ? "desde" : "no") as "no" | "desde",
      amount: moneyInput(fleet.freeFromCents, store.currency),
    },
    validators: {
      onSubmit: z
        .object({ mode: z.custom<"no" | "desde">(), amount: z.string() })
        .superRefine((v, ctx) => {
          if (v.mode === "desde" && !readMoney(v.amount, store.currency))
            ctx.addIssue({
              code: "custom",
              path: ["amount"],
              message: "Escribe desde qué compra, como 200",
            })
        }),
    },
    onSubmit: async ({ value }) => {
      await save.mutateAsync({
        id: fleet.id,
        body: methodBody(fleet, {
          freeFromCents: value.mode === "desde" ? readMoney(value.amount, store.currency) : null,
        }),
      })
      await refresh()
      toast.success("Envío gratis guardado")
    },
  })
  const surface = useFormSurface(form, { fieldMap: { freeFromCents: "amount" } })
  const togglePay = async (index: number) => {
    const seen = fleet.zones[index]
    if (!seen || zoneChange.isPending) return
    const zone = { ...seen, payOnDelivery: !seen.payOnDelivery }
    try {
      // Solo esa zona, sobre lo guardado ahora.
      await zoneChange.mutateAsync({ op: "zona", before: seen.name, seen, zone })
      await refresh()
      toast.success(
        zone.payOnDelivery
          ? `${zone.name}: acepta pago al recibir`
          : `${zone.name}: Sofi pide el pago antes`,
      )
    } catch (error) {
      if (isStale(error)) {
        await refresh()
        toast.error(STALE_SEEN)
      } else toast.error(submitErrorMessage(error))
    }
  }
  return (
    <Card
      title="Reglas"
      description="Tres reglas de tu tienda. Sofi las dice antes de que la clienta pague."
    >
      <div className="flex flex-col divide-y">
        <RuleRow title="Envío gratis">
          {canEdit ? (
            <form noValidate onSubmit={surface.onSubmit} className="flex flex-col gap-3">
              <form.AppField name="mode">
                {(field) => (
                  <RadioChips
                    aria-labelledby={freeId}
                    aria-label="Envío gratis"
                    value={field.state.value}
                    options={[
                      { value: "no", label: "No doy envío gratis" },
                      { value: "desde", label: "Gratis desde un monto" },
                    ]}
                    onChange={(next) => field.handleChange(next)}
                  />
                )}
              </form.AppField>
              <form.Subscribe selector={(state) => state.values.mode}>
                {(mode) =>
                  mode === "desde" ? (
                    <form.AppField name="amount">
                      {(field) => (
                        <field.Control label="Desde una compra de" className="max-w-48">
                          {(control) => (
                            <MoneyInput
                              control={control}
                              currency={store.currency}
                              value={field.state.value}
                              onChange={field.handleChange}
                            />
                          )}
                        </field.Control>
                      )}
                    </form.AppField>
                  ) : null
                }
              </form.Subscribe>
              <div className="flex items-center gap-3">
                <SubmitButton
                  type="submit"
                  size="sm"
                  variant="outline"
                  pending={surface.isSubmitting}
                >
                  Guardar
                </SubmitButton>
                {surface.error ? (
                  <p role="alert" className="text-sm text-danger">
                    {surface.error}
                  </p>
                ) : null}
              </div>
            </form>
          ) : (
            <p className="text-sm">
              {fleet.freeFromCents
                ? `Gratis desde ${money(fleet.freeFromCents, store.currency)}`
                : "No da envío gratis"}
            </p>
          )}
          <p id={freeId} className="text-sm text-muted-foreground">
            {free.length === 0
              ? "Ninguna zona tiene envío gratis."
              : `Vale en ${free.join(", ")}${notFree.length ? `; en ${notFree.join(", ")}, no` : ""}. Se cambia en cada zona. Sofi lo usa para que la clienta sume algo.`}
          </p>
        </RuleRow>
        <FailedTripRow setup={setup} canEdit={canEdit} />
        <RuleRow title="Pago al recibir">
          <fieldset className="m-0 flex min-w-0 flex-wrap gap-2 border-0 p-0">
            <legend className="sr-only">Zonas con pago al recibir</legend>
            {fleet.zones.map((zone, index) => (
              <Button
                key={zone.name}
                type="button"
                size="sm"
                variant={zone.payOnDelivery ? "default" : "outline"}
                aria-pressed={zone.payOnDelivery}
                disabled={!canEdit || zoneChange.isPending}
                onClick={() => void togglePay(index)}
              >
                {zone.name}
              </Button>
            ))}
          </fieldset>
          <p className="text-sm text-muted-foreground">
            Donde no lo marcas, Sofi pide el pago antes. Sin pago confirmado no se entrega.
          </p>
        </RuleRow>
      </div>
    </Card>
  )
}

function RuleRow({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="grid gap-3 px-5 py-4 @2xl:grid-cols-[13rem_minmax(0,1fr)]">
      <h3 className="text-sm font-semibold">{title}</h3>
      <div className="flex min-w-0 flex-col gap-2">{children}</div>
    </div>
  )
}

const FAILED_OPTIONS = (Object.keys(FAILED_TRIP_TEXT) as FailedTrip[]).map((value) => ({
  value,
  label: FAILED_TRIP_TEXT[value],
}))

/** Quién paga el viaje si la clienta no está: se guarda al tocar. */
function FailedTripRow({ setup, canEdit }: { setup: DeliverySetup; canEdit: boolean }) {
  const { store } = useStoreContext()
  const refresh = useRefresh(store.id)
  const save = useMutation({
    mutationFn: (failedTrip: FailedTrip) =>
      api(`/api/tiendas/${store.id}/entregas/reglas`, { method: "PATCH", body: { failedTrip } }),
    onSuccess: async () => {
      await refresh()
      toast.success("Guardado")
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const value = save.isPending && save.variables ? save.variables : setup.failedTrip
  return (
    <RuleRow title="Si la clienta no está">
      {canEdit ? (
        <RadioChips
          aria-label="Si la clienta no está"
          value={value}
          options={FAILED_OPTIONS}
          disabled={save.isPending}
          onChange={(next) => save.mutate(next)}
        />
      ) : (
        <p className="text-sm">{FAILED_TRIP_TEXT[setup.failedTrip]}</p>
      )}
      <p className="text-sm text-muted-foreground">
        Sofi se lo dice a la clienta antes de pagar. En Despachos, «No se entregó» te recuerda tu
        regla.
      </p>
    </RuleRow>
  )
}

function FailedTripRule({ setup, canEdit }: { setup: DeliverySetup; canEdit: boolean }) {
  return (
    <Card title="Reglas">
      <FailedTripRow setup={setup} canEdit={canEdit} />
    </Card>
  )
}

/* --------------------------------------------------------------- recojo y agencia */

function PickupCard({ method, canEdit }: { method: DeliveryMethod | null; canEdit: boolean }) {
  const { store } = useStoreContext()
  const [open, setOpen] = useState(false)
  return (
    <Card
      title="Recojo en tienda"
      icon={<Store aria-hidden className="size-4 text-muted-foreground" />}
      action={
        method ? (
          <>
            <Badge variant="outline">
              {method.cost === "gratis" ? "Gratis" : money(method.priceCents ?? 0, store.currency)}
            </Badge>
            <ActiveSwitch
              path={`/api/tiendas/${store.id}/formas-de-entrega/${method.id}`}
              storeId={store.id}
              name={method.name}
              active={method.isActive}
              canEdit={canEdit}
            />
          </>
        ) : null
      }
    >
      {method ? (
        <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 px-5 py-4 text-sm">
          <dt className="text-muted-foreground">Dirección</dt>
          <dd>{method.details || "Sin dirección"}</dd>
          <dt className="text-muted-foreground">Horario</dt>
          <dd>
            {method.openingHours.length > 0
              ? method.openingHours.map((h) => <div key={hoursText(h)}>{hoursText(h)}</div>)
              : method.eta || "Sin horario"}
          </dd>
          <dt className="text-muted-foreground">Listo en</dt>
          <dd>{method.readyIn ? READY_TEXT[method.readyIn] : "Sin decir"}</dd>
          <dt className="text-muted-foreground">Pago al recoger</dt>
          <dd>{method.acceptsPayOnDelivery ? "Sí" : "No: paga antes"}</dd>
          {canEdit ? (
            <dd className="col-span-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                <Pencil aria-hidden />
                Editar
              </Button>
            </dd>
          ) : null}
        </dl>
      ) : (
        <EmptyState
          icon={Store}
          title="Sin recojo en tienda"
          description="La clienta pasa por su pedido: dirección, horario y en cuánto está listo."
          actionLabel={canEdit ? "Agregar recojo" : undefined}
          onAction={canEdit ? () => setOpen(true) : undefined}
        />
      )}
      {open ? <PickupForm method={method} onClose={() => setOpen(false)} /> : null}
    </Card>
  )
}

interface HoursRow {
  days: number[]
  opens: string
  closes: string
}

function PickupForm({ method, onClose }: { method: DeliveryMethod | null; onClose: () => void }) {
  const { store } = useStoreContext()
  const refresh = useRefresh(store.id)
  const save = useSaveMethod(store.id)
  const readyId = useId()
  const form = useAppForm({
    defaultValues: {
      name: method?.name ?? "Recojo en la tienda",
      details: method?.details ?? "",
      hours: (method?.openingHours.length
        ? method.openingHours
        : [{ days: [1, 2, 3, 4, 5, 6], opens: 600, closes: 1140 }]
      ).map((h) => ({
        days: h.days,
        opens: toClock(h.opens),
        closes: toClock(h.closes),
      })) as HoursRow[],
      readyIn: (method?.readyIn ?? "2h") as ReadyIn,
      payOnDelivery: method?.acceptsPayOnDelivery ?? true,
    },
    validators: {
      onSubmit: z
        .object({
          name: z.string(),
          details: z.string(),
          hours: z.array(
            z.object({ days: z.array(z.number()), opens: z.string(), closes: z.string() }),
          ),
          readyIn: z.custom<ReadyIn>(),
          payOnDelivery: z.boolean(),
        })
        .superRefine((v, ctx) => {
          if (!v.name.trim())
            ctx.addIssue({ code: "custom", path: ["name"], message: "Escribe cómo lo dirá Sofi" })
          if (!v.details.trim())
            ctx.addIssue({ code: "custom", path: ["details"], message: "Escribe la dirección" })
          v.hours.forEach((h, i) => {
            const from = clockMinutes(h.opens)
            const to = clockMinutes(h.closes)
            if (h.days.length === 0)
              ctx.addIssue({
                code: "custom",
                path: [`hours[${i}].days`],
                message: "Elige los días",
              })
            if (from === null || to === null || from >= to)
              ctx.addIssue({
                code: "custom",
                path: [`hours[${i}].closes`],
                message: "Cierra después de abrir",
              })
          })
        }),
    },
    onSubmit: async ({ value }) => {
      const openingHours: OpeningHours[] = value.hours.map((h) => ({
        days: [...h.days].sort((a, b) => a - b),
        opens: clockMinutes(h.opens) ?? 0,
        closes: clockMinutes(h.closes) ?? 0,
      }))
      const change = {
        name: value.name.trim(),
        details: value.details.trim(),
        openingHours,
        readyIn: value.readyIn,
        acceptsPayOnDelivery: value.payOnDelivery,
      }
      await save.mutateAsync(
        method
          ? { id: method.id, body: methodBody(method, change) }
          : { id: null, body: { ...change, type: "OnSitePickup", cost: "gratis" } },
      )
      await refresh()
      toast.success(method ? "Recojo guardado" : "Recojo agregado")
      onClose()
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: { acceptsPayOnDelivery: "payOnDelivery", openingHours: "hours" },
  })
  const time = (name: `hours[${number}].opens` | `hours[${number}].closes`, label: string) => (
    <form.AppField name={name}>
      {(field) => (
        <field.Control label={label} className="w-36">
          {(control) => (
            <TimeSelect
              id={control.id}
              step={30}
              value={field.state.value}
              onChange={(next) => {
                field.handleChange(next)
                field.handleBlur()
              }}
              invalid={control.invalid}
              aria-describedby={control.describedBy}
              className="w-full"
            />
          )}
        </field.Control>
      )}
    </form.AppField>
  )
  return (
    <FormDrawer
      {...surface}
      open
      title={method ? method.name : "Nuevo recojo en tienda"}
      description="Gratis para la clienta. Sofi da la dirección y el horario."
      onClose={onClose}
      submitLabel="Guardar"
    >
      <FieldGroup className="gap-5">
        <form.AppField name="name">
          {(field) => (
            <field.TextField label="Nombre" description="Como lo dirá Sofi." maxLength={80} />
          )}
        </form.AppField>
        <form.AppField name="details">
          {(field) => (
            <field.TextField
              label="Dirección"
              placeholder="Jr. Gamarra 650, La Victoria · stand 214"
              maxLength={300}
            />
          )}
        </form.AppField>
        <form.AppField name="hours" mode="array">
          {(list) => (
            <list.Group legend="Horario">
              {() => (
                <div className="flex flex-col gap-4">
                  {list.state.value.map((_, i) => (
                    // biome-ignore lint/suspicious/noArrayIndexKey: los horarios no tienen id
                    <div key={i} className="flex flex-col gap-3 rounded-lg border p-3">
                      <form.AppField name={`hours[${i}].days`}>
                        {(field) => (
                          <fieldset className="m-0 flex min-w-0 flex-wrap gap-1.5 border-0 p-0">
                            <legend className="sr-only">{`Días del horario ${i + 1}`}</legend>
                            {WEEKDAYS.map((day) => {
                              const on = field.state.value.includes(day.value)
                              return (
                                <Button
                                  key={day.value}
                                  type="button"
                                  size="sm"
                                  variant={on ? "default" : "outline"}
                                  aria-pressed={on}
                                  aria-label={day.name}
                                  onClick={() =>
                                    field.handleChange(
                                      on
                                        ? field.state.value.filter((d) => d !== day.value)
                                        : [...field.state.value, day.value],
                                    )
                                  }
                                >
                                  {day.short}
                                </Button>
                              )
                            })}
                          </fieldset>
                        )}
                      </form.AppField>
                      <div className="flex flex-wrap items-end gap-3">
                        {time(`hours[${i}].opens`, "Abre")}
                        {time(`hours[${i}].closes`, "Cierra")}
                        {list.state.value.length > 1 ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            aria-label={`Quitar el horario ${i + 1}`}
                            onClick={() => list.removeValue(i)}
                          >
                            <Trash2 aria-hidden />
                          </Button>
                        ) : null}
                      </div>
                    </div>
                  ))}
                  {list.state.value.length < 7 ? (
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      className="self-start"
                      onClick={() => list.pushValue({ days: [7], opens: "10:00", closes: "14:00" })}
                    >
                      <Plus aria-hidden />
                      Otro horario
                    </Button>
                  ) : null}
                </div>
              )}
            </list.Group>
          )}
        </form.AppField>
        <form.AppField name="readyIn">
          {(field) => (
            <field.Group legend={<span id={readyId}>Listo para recoger en</span>}>
              {(control) => (
                <RadioChips
                  id={control.id}
                  aria-labelledby={readyId}
                  value={field.state.value}
                  options={(Object.keys(READY_TEXT) as ReadyIn[]).map((value) => ({
                    value,
                    label: READY_TEXT[value],
                  }))}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        <form.AppField name="payOnDelivery">
          {() => (
            <ToggleField
              label="Acepta pago al recoger"
              description="Apagado, paga antes de recoger."
            />
          )}
        </form.AppField>
        {method ? (
          <DeleteButton
            what={method.name}
            path={`/api/tiendas/${store.id}/formas-de-entrega/${method.id}`}
            storeId={store.id}
            onDone={onClose}
          />
        ) : null}
      </FieldGroup>
    </FormDrawer>
  )
}

function AgencyCard({ method, canEdit }: { method: DeliveryMethod | null; canEdit: boolean }) {
  const { store } = useStoreContext()
  const [open, setOpen] = useState(false)
  return (
    <Card
      title="Envío a provincia por agencia"
      icon={<Package aria-hidden className="size-4 text-muted-foreground" />}
      action={
        method ? (
          <ActiveSwitch
            path={`/api/tiendas/${store.id}/formas-de-entrega/${method.id}`}
            storeId={store.id}
            name={method.name}
            active={method.isActive}
            canEdit={canEdit}
          />
        ) : null
      }
    >
      {method ? (
        <dl className="grid grid-cols-[7.5rem_minmax(0,1fr)] gap-x-4 gap-y-2 px-5 py-4 text-sm">
          <dt className="text-muted-foreground">Agencias</dt>
          <dd className="flex flex-wrap gap-1.5">
            {method.agencies.length > 0
              ? method.agencies.map((name) => (
                  <Badge key={name} variant="outline">
                    {name}
                  </Badge>
                ))
              : method.details || "Sin elegir"}
          </dd>
          <dt className="text-muted-foreground">El flete</dt>
          <dd>
            {method.freight === "antes"
              ? `Lo cobras antes: ${money(method.freightCents ?? 0, store.currency)}`
              : method.freight === "al_recoger"
                ? "Lo paga la clienta al recoger"
                : "Sin decir"}
          </dd>
          <dt className="text-muted-foreground">Llevarlo</dt>
          <dd>
            {method.cost === "gratis"
              ? "Gratis"
              : method.cost === "fijo"
                ? money(method.priceCents ?? 0, store.currency)
                : method.cost === "se_acuerda"
                  ? "Se acuerda en el chat"
                  : "Por zona"}
          </dd>
          <dt className="text-muted-foreground">Llega</dt>
          <dd>{method.eta || "Sin decir"}</dd>
          <dd className="col-span-2 text-muted-foreground">
            Las agencias no dan una conexión: anotas el n.º de envío al marcar «Salió» y la clienta
            lo sigue en la web de la agencia.
          </dd>
          {canEdit ? (
            <dd className="col-span-2 pt-1">
              <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
                <Pencil aria-hidden />
                Editar
              </Button>
            </dd>
          ) : null}
        </dl>
      ) : (
        <EmptyState
          icon={Package}
          title="Sin envío a provincia"
          description="Shalom, Olva u otra agencia, con quién paga el flete."
          actionLabel={canEdit ? "Agregar agencia" : undefined}
          onAction={canEdit ? () => setOpen(true) : undefined}
        />
      )}
      {open ? <AgencyForm method={method} onClose={() => setOpen(false)} /> : null}
    </Card>
  )
}

const KNOWN_AGENCIES = Object.keys(AGENCY_SITES)

function AgencyForm({ method, onClose }: { method: DeliveryMethod | null; onClose: () => void }) {
  const { store } = useStoreContext()
  const refresh = useRefresh(store.id)
  const save = useSaveMethod(store.id)
  const freightId = useId()
  const carryId = useId()
  const form = useAppForm({
    defaultValues: {
      name: method?.name ?? "Envío a provincia",
      agencies: method?.agencies.filter((a) => KNOWN_AGENCIES.includes(a)) ?? [
        "Shalom",
        "Olva Courier",
      ],
      other: method?.agencies.filter((a) => !KNOWN_AGENCIES.includes(a)).join(", ") ?? "",
      freight: (method?.freight ?? "al_recoger") as Freight,
      freightAmount: moneyInput(method?.freightCents ?? null, store.currency),
      carry: (method?.cost === "gratis" ? "gratis" : "cobro") as "gratis" | "cobro",
      carryAmount: moneyInput(method?.priceCents ?? null, store.currency),
      eta: method?.eta ?? "De 2 a 4 días",
    },
    validators: {
      onSubmit: z
        .object({
          name: z.string(),
          agencies: z.array(z.string()),
          other: z.string(),
          freight: z.custom<Freight>(),
          freightAmount: z.string(),
          carry: z.custom<"cobro" | "gratis">(),
          carryAmount: z.string(),
          eta: z.string(),
        })
        .superRefine((v, ctx) => {
          if (!v.name.trim())
            ctx.addIssue({ code: "custom", path: ["name"], message: "Escribe cómo lo dirá Sofi" })
          if (v.agencies.length === 0 && !v.other.trim())
            ctx.addIssue({
              code: "custom",
              path: ["agencies"],
              message: "Elige al menos una agencia",
            })
          if (v.freight === "antes" && !readMoney(v.freightAmount, store.currency))
            ctx.addIssue({
              code: "custom",
              path: ["freightAmount"],
              message: "Escribe cuánto cobras, como 20",
            })
          if (v.carry === "cobro" && readMoney(v.carryAmount, store.currency) === null)
            ctx.addIssue({
              code: "custom",
              path: ["carryAmount"],
              message: "Escribe cuánto cobras, como 8",
            })
        }),
    },
    onSubmit: async ({ value }) => {
      const others = value.other
        .split(",")
        .map((a) => a.trim())
        .filter(Boolean)
      const change = {
        name: value.name.trim(),
        agencies: [...value.agencies, ...others],
        freight: value.freight,
        freightCents:
          value.freight === "antes" ? readMoney(value.freightAmount, store.currency) : null,
        cost: value.carry === "gratis" ? ("gratis" as const) : ("fijo" as const),
        priceCents: value.carry === "gratis" ? null : readMoney(value.carryAmount, store.currency),
        zones: [],
        maxDiscountCents: null,
        freeFromCents: null,
        eta: value.eta.trim(),
      }
      await save.mutateAsync(
        method
          ? { id: method.id, body: methodBody(method, change) }
          : { id: null, body: { ...change, type: "ParcelService" } },
      )
      await refresh()
      toast.success(method ? "Agencia guardada" : "Agencia agregada")
      onClose()
    },
  })
  const surface = useFormSurface(form, {
    fieldMap: { freightCents: "freightAmount", priceCents: "carryAmount" },
  })
  const amount = (name: "freightAmount" | "carryAmount", label: string) => (
    <form.AppField name={name}>
      {(field) => (
        <field.Control label={label} className="max-w-40">
          {(control) => (
            <MoneyInput
              control={control}
              currency={store.currency}
              value={field.state.value}
              onChange={field.handleChange}
            />
          )}
        </field.Control>
      )}
    </form.AppField>
  )
  return (
    <FormDrawer
      {...surface}
      open
      title={method ? method.name : "Envío a provincia"}
      description="Con qué agencias envías y quién paga el flete."
      onClose={onClose}
      submitLabel="Guardar"
    >
      <FieldGroup className="gap-5">
        <form.AppField name="name">
          {(field) => (
            <field.TextField label="Nombre" description="Como lo dirá Sofi." maxLength={80} />
          )}
        </form.AppField>
        <form.AppField name="agencies">
          {(field) => (
            <field.Group legend="Agencias">
              {() => (
                <div className="flex flex-wrap gap-2">
                  {KNOWN_AGENCIES.map((name) => {
                    const on = field.state.value.includes(name)
                    return (
                      <Button
                        key={name}
                        type="button"
                        size="sm"
                        variant={on ? "default" : "outline"}
                        aria-pressed={on}
                        onClick={() =>
                          field.handleChange(
                            on
                              ? field.state.value.filter((a) => a !== name)
                              : [...field.state.value, name],
                          )
                        }
                      >
                        {name}
                      </Button>
                    )
                  })}
                </div>
              )}
            </field.Group>
          )}
        </form.AppField>
        <form.AppField name="other">
          {(field) => (
            <field.TextField
              label="Otra agencia (opcional)"
              placeholder="Cruz del Sur Cargo"
              maxLength={120}
            />
          )}
        </form.AppField>
        <form.AppField name="freight">
          {(field) => (
            <field.Group legend={<span id={freightId}>El flete</span>}>
              {(control) => (
                <RadioChips
                  id={control.id}
                  aria-labelledby={freightId}
                  value={field.state.value}
                  options={[
                    { value: "al_recoger", label: "Lo paga la clienta al recoger" },
                    { value: "antes", label: "Lo cobro antes" },
                  ]}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        <form.Subscribe selector={(state) => state.values.freight}>
          {(freight) => (freight === "antes" ? amount("freightAmount", "Flete") : null)}
        </form.Subscribe>
        <form.AppField name="carry">
          {(field) => (
            <field.Group legend={<span id={carryId}>Llevarlo a la agencia</span>}>
              {(control) => (
                <RadioChips
                  id={control.id}
                  aria-labelledby={carryId}
                  value={field.state.value}
                  options={[
                    { value: "cobro", label: "Lo cobro" },
                    { value: "gratis", label: "Gratis" },
                  ]}
                  onChange={(next) => field.handleChange(next)}
                />
              )}
            </field.Group>
          )}
        </form.AppField>
        <form.Subscribe selector={(state) => state.values.carry}>
          {(carry) => (carry === "cobro" ? amount("carryAmount", "Cuánto") : null)}
        </form.Subscribe>
        <form.AppField name="eta">
          {(field) => (
            <field.TextField label="Cuándo llega" placeholder="De 2 a 4 días" maxLength={120} />
          )}
        </form.AppField>
        <p className="text-sm text-muted-foreground">
          Lo que cobra la tienda es llevarlo a la agencia, más el flete si lo cobras antes.
        </p>
        {method ? (
          <DeleteButton
            what={method.name}
            path={`/api/tiendas/${store.id}/formas-de-entrega/${method.id}`}
            storeId={store.id}
            onDone={onClose}
          />
        ) : null}
      </FieldGroup>
    </FormDrawer>
  )
}

/* --------------------------------------------------------------------- las demás */

/** Las formas que no son el reparto, el recojo ni la agencia principales: se ven y se apagan. */
function OtherMethods({ methods, canEdit }: { methods: DeliveryMethod[]; canEdit: boolean }) {
  const { store } = useStoreContext()
  return (
    <Card title="Otras formas de entrega">
      <ul className="flex flex-col divide-y">
        {methods.map((method) => (
          <li
            key={method.id}
            className="flex flex-wrap items-center justify-between gap-3 px-5 py-3 text-sm"
          >
            <div className="flex flex-col">
              <span className="font-semibold">{method.name}</span>
              <span className="text-muted-foreground">{DELIVERY_TYPES[method.type]}</span>
            </div>
            <div className="flex items-center gap-2">
              <ActiveSwitch
                path={`/api/tiendas/${store.id}/formas-de-entrega/${method.id}`}
                storeId={store.id}
                name={method.name}
                active={method.isActive}
                canEdit={canEdit}
              />
              {canEdit ? (
                <DeleteButton
                  what={method.name}
                  path={`/api/tiendas/${store.id}/formas-de-entrega/${method.id}`}
                  storeId={store.id}
                  onDone={() => {}}
                />
              ) : null}
            </div>
          </li>
        ))}
      </ul>
    </Card>
  )
}

/* ---------------------------------------------------------------------- las franjas */

/**
 * Las franjas de entrega (Despachos): opcionales. Cada zona elige las suyas; un pedido sin franja
 * sale igual. Cada cambio se guarda al momento; quitar una no cambia los pedidos que ya la tienen.
 */
function SlotsSection({
  storeId,
  slots,
  canEdit,
}: {
  storeId: string
  slots: DeliverySetup["slots"]
  canEdit: boolean
}) {
  const refresh = useRefresh(storeId)
  const id = useId()
  const plain = slots.map((slot) => ({ start: slot.start, end: slot.end }))
  const saveSlots = (next: { start: number; end: number }[]) =>
    api(`/api/tiendas/${storeId}/franjas`, { method: "PATCH", body: { slots: next } })
  const remove = useMutation({
    mutationFn: saveSlots,
    onSuccess: async () => {
      await refresh()
      toast.success("Franjas guardadas")
    },
  })
  const add = useMutation({ mutationFn: saveSlots })
  const form = useAppForm({
    defaultValues: { start: "", end: "" },
    validators: {
      onSubmit: z
        .object({
          start: z.string().min(1, "Elige desde qué hora"),
          end: z.string().min(1, "Elige hasta qué hora"),
        })
        .superRefine((value, ctx) => {
          const from = clockMinutes(value.start)
          const to = clockMinutes(value.end)
          if (from === null || to === null) return
          if (from >= to)
            ctx.addIssue({
              code: "custom",
              path: ["end"],
              message: "La franja termina después de empezar",
            })
          else if (plain.some((slot) => slot.start === from && slot.end === to))
            ctx.addIssue({ code: "custom", path: ["end"], message: "Esa franja ya está" })
        }),
    },
    onSubmit: async ({ value, formApi }) => {
      await add.mutateAsync([
        ...plain,
        { start: clockMinutes(value.start) ?? 0, end: clockMinutes(value.end) ?? 0 },
      ])
      await refresh()
      formApi.reset()
      toast.success("Franjas guardadas")
    },
  })
  const { onSubmit, isSubmitting: pending, error: addError } = useFormSurface(form)
  const timeField = (name: "start" | "end", label: string) => (
    <form.AppField name={name}>
      {(field) => (
        <field.Control label={label} className="w-36">
          {(control) => (
            <TimeSelect
              id={control.id}
              step={30}
              value={field.state.value}
              onChange={(next) => {
                field.handleChange(next)
                field.handleBlur()
              }}
              invalid={control.invalid}
              aria-describedby={control.describedBy}
              className="w-full"
            />
          )}
        </field.Control>
      )}
    </form.AppField>
  )
  return (
    <section aria-labelledby={id} className="elevated overflow-hidden rounded-xl border bg-card">
      <div className="flex flex-col gap-1 border-b px-5 py-4">
        <h2 id={id} className="text-base font-semibold">
          Franjas de entrega
        </h2>
        <p className="text-sm text-muted-foreground">
          Cada zona elige las suyas. En Despachos, cada día se ordena por franja; un pedido sin
          franja sale igual.
        </p>
      </div>
      <div className="flex flex-col gap-4 px-5 py-4">
        {slots.length === 0 ? (
          <p className="text-sm text-muted-foreground">Todavía no hay franjas.</p>
        ) : (
          <ul className="flex flex-wrap gap-2">
            {slots.map((slot) => (
              <li
                key={`${slot.start}-${slot.end}`}
                className="flex items-center gap-1 rounded-full border py-1 pr-1 pl-3 text-sm"
              >
                <Clock aria-hidden className="size-3.5 text-muted-foreground" />
                {slot.label}
                {canEdit ? (
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-7"
                    aria-label={`Quitar la franja ${slot.label}`}
                    disabled={remove.isPending || pending}
                    onClick={() =>
                      remove.mutate(
                        plain.filter((s) => s.start !== slot.start || s.end !== slot.end),
                      )
                    }
                  >
                    <Trash2 aria-hidden />
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {canEdit ? (
          <form noValidate className="flex flex-col gap-2" onSubmit={onSubmit}>
            <FieldGroup className="flex-row flex-wrap items-end gap-3">
              {timeField("start", "Desde")}
              {timeField("end", "Hasta")}
              <SubmitButton type="submit" variant="outline" pending={pending}>
                <Plus aria-hidden />
                Agregar franja
              </SubmitButton>
            </FieldGroup>
            {addError ? (
              <p role="alert" className="text-sm text-danger">
                {addError}
              </p>
            ) : null}
          </form>
        ) : null}
        {remove.isError ? (
          <p role="alert" className="text-sm text-danger">
            {submitErrorMessage(remove.error)}
          </p>
        ) : null}
      </div>
    </section>
  )
}

/** Encender o apagar guarda al momento; si falla, vuelve como estaba y lo dice. */
function ActiveSwitch({
  path,
  storeId,
  name,
  active,
  canEdit,
}: {
  path: string
  storeId: string
  name: string
  active: boolean
  canEdit: boolean
}) {
  const queryClient = useQueryClient()
  const toggle = useMutation({
    mutationFn: (isActive: boolean) => api(path, { method: "PATCH", body: { isActive } }),
    onSuccess: async (_, isActive) => {
      await queryClient.invalidateQueries({ queryKey: LISTS_PREFIX(storeId) })
      toast.success(isActive ? `${name}: encendido` : `${name}: apagado, Sofi ya no lo ofrece`)
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const shown = toggle.isPending ? Boolean(toggle.variables) : active
  if (!canEdit) return <Badge variant="outline">{active ? "Encendido" : "Apagado"}</Badge>
  return (
    <div className="flex items-center gap-2 text-sm">
      <Switch
        checked={shown}
        disabled={toggle.isPending}
        onCheckedChange={(next) => toggle.mutate(next)}
        aria-label={`${name}: ${shown ? "encendido" : "apagado"}`}
      />
      <span aria-hidden>{shown ? "Encendido" : "Apagado"}</span>
    </div>
  )
}

/** Borrar, con su confirmación: lo que ya se cobró o entregó conserva lo suyo. */
function DeleteButton({
  what,
  path,
  storeId,
  onDone,
}: {
  what: string
  path: string
  storeId: string
  onDone: () => void
}) {
  const queryClient = useQueryClient()
  const [asking, setAsking] = useState(false)
  const remove = useMutation({
    mutationFn: () => api(path, { method: "DELETE" }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: LISTS_PREFIX(storeId) })
      toast.success(`${what} borrado`)
      setAsking(false)
      onDone()
    },
  })
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="self-start text-danger"
        onClick={() => setAsking(true)}
      >
        <Trash2 aria-hidden />
        Borrar
      </Button>
      <ConfirmDialog
        open={asking}
        title={`¿Borrar «${what}»?`}
        description="Sofi deja de ofrecerlo. Si solo es por un tiempo, mejor apágalo."
        confirmLabel="Borrar"
        pending={remove.isPending}
        error={remove.isError ? submitErrorMessage(remove.error) : null}
        onConfirm={() => remove.mutate()}
        onClose={() => setAsking(false)}
      />
    </>
  )
}

import {
  Button,
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  cn,
  Skeleton,
  toast,
} from "@odentia/ui"
import {
  type CountryCode,
  countryOptions,
  EmptyState,
  ErrorState,
  SectionNav,
  type SectionNavGroup,
  SkeletonRegion,
  SubmitButton,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { Link, Navigate, useLocation, useNavigate } from "@tanstack/react-router"
import { Check, ChevronLeft, ChevronRight, Info, Minus, Search, Settings } from "lucide-react"
import { type ReactNode, useId, useMemo, useState } from "react"
import { z } from "zod"
import { useZones, zoneLabel } from "./hora"
import { api, type MyStore } from "./lib/api"
import {
  CONFIG_HOME_PATH,
  type ConfigLine,
  type ConfigOverview,
  type ConfigSection,
  type ConfigSectionId,
  configEntryFor,
  configGroupsFor,
  configLines,
  configSectionOf,
  namesIndex,
  notYoursText,
  SEARCH_INDEX,
  type SearchResult,
  searchConfig,
  seesSection,
  setupProgress,
  type ToDoItem,
  toDoItems,
  toDoTitle,
} from "./lib/configuracion"
import { DraftGuard } from "./lib/draft-guard"
import { currencySymbol } from "./lib/tienda"
import { RouterLink, StoreHeader, useStoreContext } from "./tiendas"

/**
 * Lo que dice una parte sin estado propio: los avisos son de cada persona y el plan, mientras la
 * administración no dijo nada todavía, no tiene cifras que mostrar.
 */
const PLAIN_SUMMARY: Partial<Record<ConfigSectionId, string>> = {
  avisos: "Lo que te llega a ti, en cada celular",
  plan: "Tu plan, lo que gastó Sofi y tus pagos",
}
/**
 * Lo guardado en cada apartado, para «Lo que falta» y el buscador (tablero 3). Lo pide quien ve
 * «Lo que falta»: quien configura la tienda y soporte.
 */
function useConfigOverview(store: MyStore) {
  const home = configSectionOf(CONFIG_HOME_PATH)
  return useQuery({
    queryKey: ["configuracion-resumen", store.id],
    queryFn: () => api<ConfigOverview>(`/api/tiendas/${store.id}/configuracion/resumen`),
    enabled: home !== null && seesSection(store, home),
  })
}

/**
 * Configuración (lienzo «gestorIA · Configuración, de nuevo», tablero 3): abre con «Lo que falta»
 * y sigue en grupos con nombres de tarea, a la izquierda, con el buscador encima. En el teléfono
 * no hay barra de secciones: la portada es el índice, una parte por pantalla, y cada parte vuelve
 * a ella con «Configuración». Cada apartado lo ve quien puede cambiarlo (`lib/configuracion.ts`): a
 * quien abre uno que no es suyo se le dice, sin mostrarlo.
 */
export function ConfigFrame({ children }: { children: ReactNode }) {
  const { store } = useStoreContext()
  const { pathname } = useLocation()
  const base = `/tiendas/${store.id}`
  const visible = configGroupsFor(store)
  const overview = useConfigOverview(store)
  // La misma cuenta que «Lo que falta» y que Inicio.
  const left = overview.data ? setupProgress(overview.data.steps).left : 0
  const groups: SectionNavGroup[] = visible.map((group) => ({
    label: group.label,
    items: group.items.map((item) => ({
      label: item.label,
      to: `${base}${item.path}`,
      // «Lo que falta» dice cuántas cosas faltan; las demás partes lo dicen en su línea.
      ...(item.path === CONFIG_HOME_PATH && left > 0 ? { badge: left } : {}),
    })),
  }))
  const inside = pathname.startsWith(base) ? pathname.slice(base.length).replace(/\/$/, "") : ""
  const section = configSectionOf(inside)
  const entry = configEntryFor(store)
  const isHome = section?.path === CONFIG_HOME_PATH
  // Quien no ve «Lo que falta» (Ventas) llega directo a lo suyo, no a una página vacía.
  if (isHome && section && !seesSection(store, section) && entry)
    return <Navigate to={`${base}${entry.path}`} replace />
  const home = configSectionOf(CONFIG_HOME_PATH)
  const hasHome = home !== null && seesSection(store, home)
  const single = visible.flatMap((group) => group.items).length === 1
  const notYours = notYoursText(store, section)
  const content =
    section && seesSection(store, section) ? (
      children
    ) : (
      <>
        <StoreHeader title="Configuración" />
        <EmptyState icon={Settings} title={notYours.title} description={notYours.description} />
      </>
    )
  // Quien no configura la tienda (Ventas) ve solo lo suyo: una línea le dice por qué.
  const onlyYours =
    !hasHome && store.role !== "support" ? (
      <p className="flex items-start gap-2 text-sm text-muted-foreground">
        <Info aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>
          Aquí ves lo que cambias tú. Los datos de la tienda, Sofi, los cobros, las entregas y el
          equipo los cambian el Dueño y el Administrador.
        </span>
      </p>
    ) : null
  if (visible.length === 0)
    return (
      <div className="flex flex-col gap-6">
        {content}
        {onlyYours}
      </div>
    )
  return (
    <div className="relative">
      {hasHome ? (
        // El buscador va sobre la lista de partes; en el teléfono, en la portada.
        <div className="hidden lg:absolute lg:top-0 lg:left-0 lg:block lg:w-64">
          <ConfigSearch store={store} overview={overview.data} />
        </div>
      ) : null}
      <SectionNav
        label="Configuración"
        groups={groups}
        items={[]}
        pathname={pathname}
        LinkComponent={RouterLink}
        // En el teléfono la portada es el índice: sin la barra flotante «Cambiar sección» (ni para
        // quien tiene una sola parte). `SectionNav` todavía no tiene ese modo: se esconde su barra
        // desde aquí.
        className={cn(
          (hasHome || single) && "max-lg:min-h-0! max-lg:[&>nav]:hidden",
          hasHome && "lg:[&>nav]:mt-14",
        )}
      >
        <div className="flex flex-col gap-6">
          {hasHome && !isHome ? (
            <Link
              to={`${base}${CONFIG_HOME_PATH}`}
              className="-mb-3 inline-flex min-h-11 w-fit items-center gap-1 rounded-md text-sm font-medium text-primary hover:underline focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 lg:hidden"
            >
              <ChevronLeft aria-hidden className="size-4" />
              Configuración
            </Link>
          ) : null}
          {content}
          {onlyYours}
        </div>
      </SectionNav>
    </div>
  )
}

/**
 * El buscador propio de Configuración (no el de Ctrl+K): encuentra cada parte por lo que hay
 * dentro («yape», «shalom», «envío gratis») y por los nombres que guardó la tienda. Es el cuadro
 * combinado común (`Combobox`, patrón «combobox» de WAI-ARIA): las flechas recorren los
 * resultados, Enter abre el elegido y Escape cierra la lista. Cada resultado dice dónde está.
 */
export function ConfigSearch({
  store,
  overview,
  className,
}: {
  store: MyStore
  overview: ConfigOverview | undefined
  className?: string
}) {
  const navigate = useNavigate()
  const id = useId()
  const [query, setQuery] = useState("")
  const [open, setOpen] = useState(false)
  const entries = useMemo(() => [...SEARCH_INDEX, ...namesIndex(overview)], [overview])
  const results = useMemo(() => searchConfig(query, store, entries), [query, store, entries])
  const typed = query.trim().length > 0
  return (
    <div className={cn("relative", className)}>
      <label htmlFor={`${id}-buscar`} className="sr-only">
        Buscar en Configuración
      </label>
      <Combobox
        items={results}
        filter={null}
        value={null}
        open={open && typed}
        onOpenChange={setOpen}
        inputValue={query}
        itemToStringLabel={(result: SearchResult) => result.text}
        onInputValueChange={(next, details) => {
          if (details.reason !== "input-change") return
          setQuery(next)
          setOpen(true)
        }}
        onValueChange={(result: SearchResult | null) => {
          if (!result) return
          setQuery("")
          setOpen(false)
          // El foco va al título de la parte abierta: el buscador puede desaparecer (en el
          // teléfono vive en la portada) y el foco no se queda perdido en la página.
          void navigate({ to: `/tiendas/${store.id}${result.section.path}` }).then(() =>
            requestAnimationFrame(() => {
              const title =
                document.querySelector<HTMLElement>("main h1") ??
                document.querySelector<HTMLElement>("main")
              if (!title) return
              title.tabIndex = -1
              title.focus()
            }),
          )
        }}
      >
        <div className="relative">
          <Search
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 z-10 size-4 -translate-y-1/2 text-muted-foreground"
          />
          <ComboboxInput
            id={`${id}-buscar`}
            className="w-full [&_input]:pl-9"
            placeholder="Buscar en Configuración"
            autoComplete="off"
            showTrigger={false}
          />
        </div>
        <ComboboxContent aria-label="Resultados en Configuración">
          <ComboboxEmpty>
            No encontramos «{query.trim()}». Prueba con otra palabra, como «yape» o «envío».
          </ComboboxEmpty>
          <ComboboxList aria-label="Resultados en Configuración">
            {(result: SearchResult) => (
              <ComboboxItem
                key={`${result.section.id}-${result.text}`}
                value={result}
                className="items-start"
              >
                <span className="flex min-w-0 flex-col">
                  <span className="break-words">{result.text}</span>
                  <span className="text-xs font-normal text-muted-foreground">
                    {result.section.label}
                  </span>
                </span>
              </ComboboxItem>
            )}
          </ComboboxList>
        </ComboboxContent>
      </Combobox>
    </div>
  )
}

/**
 * «Lo que falta» (tablero 3), donde abre Configuración: arriba, la lista corta de lo que falta
 * para vender, cada cosa con su botón; debajo, cada parte en una línea con cómo está y un punto
 * en la que tiene algo pendiente. En el teléfono, esas líneas son el índice de Configuración.
 */
export function ConfigHomePage() {
  const { store } = useStoreContext()
  const overview = useConfigOverview(store)
  return (
    <>
      <StoreHeader title="Configuración" />
      <ConfigSearch store={store} overview={overview.data} className="lg:hidden" />
      {overview.isPending ? (
        <SkeletonRegion message="Cargando lo que falta" className="flex flex-col gap-6">
          <div className="elevated flex flex-col gap-4 rounded-xl border bg-card p-5">
            <Skeleton className="h-5 w-2/5" />
            {[0, 1, 2, 3].map((row) => (
              <Skeleton key={row} className="h-10 w-full" />
            ))}
          </div>
          <div className="flex flex-col gap-2">
            {[0, 1, 2, 3, 4].map((row) => (
              <Skeleton key={row} className="h-12 w-full" />
            ))}
          </div>
        </SkeletonRegion>
      ) : overview.isError ? (
        <ErrorState error={overview.error} onRetry={() => void overview.refetch()} />
      ) : (
        <>
          <ToDoCard store={store} overview={overview.data} />
          <PartsIndex store={store} lines={configLines(overview.data, store)} />
        </>
      )}
    </>
  )
}

function ToDoCard({ store, overview }: { store: MyStore; overview: ConfigOverview }) {
  const canChange = store.permissions.includes("configuracion")
  const { selling, more } = toDoItems(overview, store)
  const progress = setupProgress(overview.steps)
  // Sofi vende sola solo con los chats conectables y sin haberla saltado.
  const chatsReady = overview.steps.some((s) => s.step === "chats" && s.state !== "pronto")
  const sofiSells = chatsReady && selling.find((item) => item.id === "sofi")?.state !== "saltado"
  const title = toDoTitle(progress.left, sofiSells)
  const moreLeft = more.filter((item) => item.state === "opcional")
  // Solo lo primero que falta lleva el botón principal; lo demás, el secundario.
  const first = selling.find((item) => item.state === "falta")?.id
  if (progress.left === 0 && moreLeft.length === 0)
    return (
      <section
        aria-label="Lo que falta para vender"
        className="elevated flex items-center gap-3 rounded-xl border bg-card p-5"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-success-soft text-success">
          <Check aria-hidden className="size-4" />
        </span>
        <p className="font-semibold">{title}: cada parte está lista.</p>
      </section>
    )
  let number = 0
  const row = (item: ToDoItem) => {
    const pending = item.state === "falta" || item.state === "opcional"
    if (item.state === "falta") number += 1
    return (
      <li key={item.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 py-3">
        <span
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold",
            item.state === "hecho" && "bg-success-soft text-success",
            (item.state === "saltado" || item.state === "opcional") &&
              "bg-muted text-muted-foreground",
            item.state === "falta" && "bg-warning-soft text-warning",
          )}
        >
          {item.state === "hecho" ? (
            <Check aria-hidden className="size-4" />
          ) : item.state === "falta" ? (
            <span aria-hidden>{number}</span>
          ) : (
            <Minus aria-hidden className="size-4" />
          )}
          <span className="sr-only">
            {item.state === "hecho"
              ? "Listo:"
              : item.state === "saltado"
                ? "Saltado:"
                : item.state === "opcional"
                  ? "Cuando quieras:"
                  : "Falta:"}
          </span>
        </span>
        <div className="flex min-w-0 flex-1 basis-56 flex-col">
          <span className={cn("font-medium", !pending && "text-muted-foreground")}>
            {item.title}
          </span>
          <span className="text-sm text-muted-foreground">{item.detail}</span>
        </div>
        {pending && canChange ? (
          <Button
            size="sm"
            variant={item.id === first ? "default" : "outline"}
            className="max-sm:ml-11"
            render={<Link to={`/tiendas/${store.id}${item.action.path}`} />}
          >
            {item.action.label}
          </Button>
        ) : (
          <span className="text-sm text-muted-foreground max-sm:ml-11">
            {item.state === "hecho"
              ? "Listo"
              : item.state === "saltado"
                ? "No lo necesitas"
                : item.state === "opcional"
                  ? "Cuando quieras"
                  : "Falta"}
          </span>
        )}
      </li>
    )
  }
  return (
    <section
      aria-labelledby="lo-que-falta"
      className="elevated flex flex-col gap-1 rounded-xl border bg-card p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-4 gap-y-1 pb-2">
        <h2 id="lo-que-falta" className="text-lg font-bold">
          {title}
        </h2>
        <span className="text-sm text-muted-foreground">
          {progress.done} de {progress.total} listas
        </span>
      </div>
      <ol className="flex flex-col divide-y">{selling.map(row)}</ol>
      {/* Lo que no frena la venta: ayuda a vender más, y no se cuenta como falta. */}
      <h3 className="pt-4 text-sm font-semibold text-muted-foreground">Para vender más</h3>
      <ul className="flex flex-col divide-y">{more.map(row)}</ul>
    </section>
  )
}

/**
 * Cada parte en una línea, por grupo: cómo está y, con texto y su punto, lo que tiene pendiente.
 * En el teléfono es el índice de Configuración: cada fila abre su parte.
 */
function PartsIndex({
  store,
  lines,
}: {
  store: MyStore
  lines: Partial<Record<ConfigSection["id"], ConfigLine>>
}) {
  const groups = configGroupsFor(store)
    .map((group) => ({
      ...group,
      items: group.items.filter((item) => item.path !== CONFIG_HOME_PATH),
    }))
    .filter((group) => group.items.length > 0)
  return (
    <section aria-labelledby="cada-parte" className="flex flex-col gap-4">
      <h2 id="cada-parte" className="text-lg font-bold">
        Cómo está cada parte
      </h2>
      {groups.map((group) => (
        <div key={group.label} className="flex flex-col gap-1.5">
          <h3 className="px-1 text-xs font-bold tracking-wide text-muted-foreground uppercase">
            {group.label}
          </h3>
          <ul className="flex flex-col divide-y overflow-hidden rounded-xl border bg-card">
            {group.items.map((item) => {
              const line = lines[item.id]
              return (
                <li key={item.id}>
                  <Link
                    to={`/tiendas/${store.id}${item.path}`}
                    className="flex min-h-14 items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/30 focus-visible:ring-inset"
                  >
                    <span className="flex min-w-0 flex-1 flex-col gap-0.5 sm:flex-row sm:items-baseline sm:gap-3">
                      <span className="shrink-0 font-medium sm:w-48">{item.label}</span>
                      {/* En el teléfono la línea se parte en dos y no se corta a la mitad. */}
                      {line ? (
                        <span className="min-w-0 text-sm break-words text-muted-foreground max-sm:line-clamp-2 sm:truncate">
                          {line.summary}
                        </span>
                      ) : PLAIN_SUMMARY[item.id] ? (
                        <span className="min-w-0 text-sm break-words text-muted-foreground max-sm:line-clamp-2 sm:truncate">
                          {PLAIN_SUMMARY[item.id]}
                        </span>
                      ) : null}
                    </span>
                    {line ? (
                      <span
                        className={cn(
                          "flex shrink-0 items-center gap-1.5 text-sm",
                          line.pending ? "font-medium text-foreground" : "text-muted-foreground",
                        )}
                      >
                        {line.pending ? (
                          <>
                            <span aria-hidden className="size-2 rounded-full bg-warning" />
                            <span className="sr-only">Pendiente:</span>
                          </>
                        ) : null}
                        {line.status}
                      </span>
                    ) : null}
                    <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                  </Link>
                </li>
              )
            })}
          </ul>
        </div>
      ))}
    </section>
  )
}

/** «Soles (S/)»: el nombre de la moneda y su símbolo. */
function currencyName(code: string): string {
  let name = code
  try {
    name = new Intl.DisplayNames(["es"], { type: "currency" }).of(code) ?? code
  } catch {
    // Un navegador viejo: queda el código.
  }
  const nice = name.charAt(0).toUpperCase() + name.slice(1)
  return `${nice} (${currencySymbol(code)})`
}

/**
 * Configuración › Datos de la tienda: el nombre, el país y la hora de la tienda, con la que se
 * cuentan «hoy», «mañana», los reportes y las promociones para todo el equipo (ADR 0222). La
 * moneda queda fija desde que se creó la tienda. El logo y el color van en «Tu marca».
 */
export function StoreDataPage() {
  const { store } = useStoreContext()
  // Lo guardado manda cuando cambia (al guardar o desde otra pestaña).
  return (
    <StoreDataForm key={`${store.name}|${store.country ?? ""}|${store.timeZone}`} store={store} />
  )
}

const storeDataSchema = z.object({
  name: z.string().trim().min(1, "Escribe el nombre de tu tienda").max(80, "Máximo 80 caracteres"),
  country: z.string(),
  timeZone: z.string().min(1, "Elige la hora de tu tienda"),
})

function StoreDataForm({ store }: { store: MyStore }) {
  const canEdit = store.permissions.includes("configuracion")
  const queryClient = useQueryClient()
  const id = useId()
  const zones = useZones(store.timeZone)
  const form = useAppForm({
    defaultValues: { name: store.name, country: store.country ?? "", timeZone: store.timeZone },
    validators: { onSubmit: storeDataSchema },
    onSubmit: async ({ value }) => {
      await api(`/api/tiendas/${store.id}/datos`, {
        method: "PATCH",
        body: { name: value.name.trim(), country: value.country || null, timeZone: value.timeZone },
      })
      // La tienda (su nombre y su hora) y todo lo que cuenta días se vuelve a pedir.
      await queryClient.invalidateQueries({ queryKey: ["yo"] })
      await queryClient.invalidateQueries({ queryKey: ["configuracion-resumen", store.id] })
      if (value.timeZone !== store.timeZone)
        await Promise.all(
          ["pedidos", "reportes", "para-vender", "argos"].map((key) =>
            queryClient.invalidateQueries({ queryKey: [key, store.id] }),
          ),
        )
      toast.success("Datos de la tienda guardados")
    },
  })
  const surface = useFormSurface(form)
  const changedFrom = (values: { name: string; country: string; timeZone: string }) =>
    values.name !== store.name ||
    values.country !== (store.country ?? "") ||
    values.timeZone !== store.timeZone
  return (
    <>
      <StoreHeader
        title="Datos de la tienda"
        subtitle="Cómo se llama tu tienda, de qué país es y con qué hora se cuentan los días."
      />
      {canEdit ? (
        <form.Subscribe selector={(state) => changedFrom(state.values)}>
          {(changed) => <DraftGuard dirty={changed && !surface.isSubmitting} />}
        </form.Subscribe>
      ) : null}
      <form
        noValidate
        onSubmit={surface.onSubmit}
        className="elevated flex max-w-xl flex-col gap-5 rounded-xl border bg-card p-5"
        aria-label="Datos de la tienda"
      >
        {canEdit ? (
          <form.AppField name="name">
            {(field) => (
              <field.TextField
                label="Nombre de la tienda"
                id={`${id}-nombre`}
                maxLength={80}
                description="Así se llama en gestorIA y en lo que te cobramos. El nombre que ve el cliente va en «Tu marca»."
              />
            )}
          </form.AppField>
        ) : (
          <ReadOnly label="Nombre de la tienda" value={store.name} />
        )}
        <form.AppField name="country">
          {(field) => (
            // El nombre del país, no el prefijo del teléfono: aquí se elige dónde vende la tienda.
            <field.SelectField
              label="País de tu tienda"
              id={`${id}-pais`}
              options={countryOptions(field.state.value as CountryCode, undefined, "es").map(
                (c) => ({
                  value: c.value,
                  label: c.label,
                }),
              )}
              disabled={!canEdit}
              description="Con él te cobramos el plan con el impuesto que corresponde."
            />
          )}
        </form.AppField>
        {canEdit ? (
          <form.AppField name="timeZone">
            {(field) => (
              <field.SelectField
                label="Hora de la tienda"
                id={`${id}-zona`}
                options={zones}
                description="Con esta hora se cuentan «hoy», «mañana», los reportes y las promociones."
              />
            )}
          </form.AppField>
        ) : (
          <ReadOnly label="Hora de la tienda" value={zoneLabel(store.timeZone)} />
        )}
        <ReadOnly
          label="Moneda"
          value={currencyName(store.currency)}
          description="Fija desde que se creó la tienda."
        />
        {canEdit ? (
          <div className="flex flex-col gap-2">
            {surface.error ? (
              <p role="alert" className="text-sm text-danger">
                {surface.error}
              </p>
            ) : null}
            <div className="flex flex-wrap items-center gap-3">
              <SubmitButton type="submit" pending={surface.isSubmitting}>
                Guardar
              </SubmitButton>
              <form.Subscribe selector={(state) => changedFrom(state.values)}>
                {(changed) =>
                  changed && !surface.isSubmitting ? (
                    <span className="text-sm font-medium text-warning">Aún no se guarda</span>
                  ) : null
                }
              </form.Subscribe>
            </div>
          </div>
        ) : null}
      </form>
    </>
  )
}

/** Un dato que quien está solo mira (soporte, o la moneda, que no cambia). */
function ReadOnly({
  label,
  value,
  description,
}: {
  label: string
  value: string
  description?: string
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      <span className="text-sm font-semibold">{value}</span>
      {description ? <span className="text-sm text-muted-foreground">{description}</span> : null}
    </div>
  )
}

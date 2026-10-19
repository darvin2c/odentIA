import { canAccess, canAccessAny } from "@odentia/auth/permissions"
import {
  Button,
  Checkbox,
  cn,
  Kbd,
  KbdGroup,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Skeleton,
  toast,
} from "@odentia/ui"
import {
  Command,
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@odentia/ui/components/command"
import { DataRefreshMarker } from "@odentia/ui-patterns"
import { keepPreviousData, useQuery } from "@tanstack/react-query"
import { useRouter } from "@tanstack/react-router"
import {
  ArrowRight,
  BookOpen,
  CalendarDays,
  CircleHelp,
  FileText,
  Kanban,
  ListFilter,
  ListTodo,
  type LucideIcon,
  MessageCircle,
  Package,
  Search,
  Stethoscope,
  Tags,
  UserRound,
  Users,
  Wallet,
} from "lucide-react"
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { apiFetch } from "../lib/api"
import { useMyRole, useMyUserId } from "../lib/crm"
import {
  askHelp,
  canOpenHref,
  formatSearchMoney,
  formatSearchWhen,
  readHiddenTypes,
  readRecents,
  rememberRecent,
  SEARCH_KIND_LABELS,
  SEARCH_TYPE_LABELS,
  SEARCH_TYPE_PERMISSIONS,
  SEARCH_TYPES,
  type SearchItem,
  type SearchOwner,
  type SearchResult,
  type SearchType,
  saveHiddenTypes,
  targetHref,
  targetVerb,
} from "../lib/global-search"
import { activeOrgTimeZone, useOrgLocale } from "../lib/locale"

/**
 * Buscador rápido (Ctrl+K; lienzo «Buscador rápido odentIA», aprobado el
 * 2026-10-19; ADR 0066). Una ventana al centro que se abre desde cualquier
 * pantalla con Ctrl+K (⌘K en Mac) o con «Buscar en todo» de la cabecera. Cada
 * resultado aparece debajo de su dueño, ya abierto: Enter lleva directo a lo
 * elegido. En el teléfono ocupa la pantalla entera.
 */

export interface GlobalSearchScreen {
  label: string
  to: string
}

interface GlobalSearchContextValue {
  open: boolean
  setOpen: (open: boolean) => void
}

const GlobalSearchContext = createContext<GlobalSearchContextValue | null>(null)

function useGlobalSearch(): GlobalSearchContextValue {
  const value = useContext(GlobalSearchContext)
  if (!value) throw new Error("GlobalSearchProvider falta en el layout")
  return value
}

/** El buscador de la clínica: atajo, ventana y botón de la cabecera comparten este estado. */
export function GlobalSearchProvider({
  orgId,
  screens,
  children,
}: {
  orgId: string
  /** Las pantallas del menú que esta persona puede abrir. */
  screens: GlobalSearchScreen[]
  children: ReactNode
}) {
  const [open, setOpenState] = useState(false)
  // Al cerrar, el foco vuelve a donde estaba (también si se abrió con el teclado).
  const returnFocus = useRef<HTMLElement | null>(null)
  const setOpen = useCallback((next: boolean) => {
    if (next)
      returnFocus.current =
        document.activeElement instanceof HTMLElement ? document.activeElement : null
    setOpenState(next)
    if (!next) {
      const target = returnFocus.current
      window.setTimeout(() => target?.isConnected && target.focus(), 0)
    }
  }, [])
  const setOpenRef = useRef(setOpen)
  setOpenRef.current = setOpen
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      // Ctrl+K también es la búsqueda del navegador: aquí abre la de la clínica.
      if (
        event.key.toLowerCase() !== "k" ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey
      )
        return
      event.preventDefault()
      setOpenRef.current(!openRef.current)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])
  const value = useMemo(() => ({ open, setOpen }), [open, setOpen])
  const openRef = useRef(open)
  openRef.current = open
  return (
    <GlobalSearchContext.Provider value={value}>
      {children}
      {open ? (
        <GlobalSearchDialog orgId={orgId} screens={screens} onClose={() => setOpen(false)} />
      ) : null}
    </GlobalSearchContext.Provider>
  )
}

/** «Buscar en todo · Ctrl K» entre las utilidades de la cabecera; en el teléfono, la lupa. */
export function GlobalSearchButton() {
  const { open, setOpen } = useGlobalSearch()
  const [mac, setMac] = useState(false)
  useEffect(() => setMac(/Mac|iPhone|iPad/.test(navigator.platform)), [])
  return (
    <Button
      type="button"
      variant="outline"
      className="elevated relative h-11 gap-2 rounded-full px-3 sm:pr-2"
      onClick={() => setOpen(!open)}
      aria-expanded={open}
      aria-haspopup="dialog"
      aria-label="Buscar en todo"
      aria-keyshortcuts="Control+K Meta+K"
    >
      <Search className="size-5" aria-hidden="true" />
      <span className="hidden lg:inline">Buscar en todo</span>
      <KbdGroup className="hidden lg:inline-flex">
        <Kbd>{mac ? "⌘" : "Ctrl"}</Kbd>
        <Kbd>K</Kbd>
      </KbdGroup>
    </Button>
  )
}

const TYPE_ICONS: Record<SearchType, LucideIcon> = {
  persona: UserRound,
  cita: CalendarDays,
  conversacion: MessageCircle,
  clinica: Stethoscope,
  documento: FileText,
  dinero: Wallet,
  tarea: ListTodo,
  oportunidad: Kanban,
  servicio: Tags,
  inventario: Package,
  equipo: Users,
  respuesta: BookOpen,
}

/** Cada tipo con su ícono y su fondo: lo que lo distingue es la forma; el color ayuda. */
function TypeTile({ type, size = "md" }: { type: SearchType; size?: "sm" | "md" }) {
  const Icon = TYPE_ICONS[type]
  const tone =
    type === "persona"
      ? "bg-primary-soft text-primary-soft-foreground"
      : type === "dinero"
        ? "bg-warning-soft text-warning"
        : type === "respuesta"
          ? "bg-agent-soft text-agent"
          : "bg-muted text-foreground"
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex shrink-0 items-center justify-center",
        size === "md"
          ? "size-9 rounded-lg [&_svg]:size-[18px]"
          : "size-6 rounded-md [&_svg]:size-3.5",
        tone,
      )}
    >
      <Icon />
    </span>
  )
}

function fold(text: string): string {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLocaleLowerCase("es")
}

function GlobalSearchDialog({
  orgId,
  screens,
  onClose,
}: {
  orgId: string
  screens: GlobalSearchScreen[]
  onClose: () => void
}) {
  const router = useRouter()
  const role = useMyRole()
  // Lo reciente y el filtro son de cada persona del equipo en esta clínica.
  const scope = `${orgId}:${useMyUserId()}`
  const locale = useOrgLocale() ?? "es"
  const timeZone = activeOrgTimeZone()
  const [query, setQuery] = useState("")
  const [debounced, setDebounced] = useState("")
  const [hidden, setHidden] = useState<SearchType[]>(() => readHiddenTypes(scope))
  const recents = useMemo(
    () => (canAccess(role, "patients.read") ? readRecents(scope) : []),
    [scope, role],
  )

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 200)
    return () => clearTimeout(timer)
  }, [query])

  // Los tipos que esta persona puede ver; el filtro solo ofrece esos.
  const available = SEARCH_TYPES.filter((type) => {
    const permissions = SEARCH_TYPE_PERMISSIONS[type]
    return (
      !permissions || canAccessAny(role, [...permissions] as Parameters<typeof canAccessAny>[1])
    )
  })
  const visibleHidden = hidden.filter((type) => available.includes(type))
  const toggleType = (type: SearchType) => {
    const next = visibleHidden.includes(type)
      ? visibleHidden.filter((t) => t !== type)
      : [...visibleHidden, type]
    setHidden(next)
    saveHiddenTypes(scope, next)
  }
  const showAll = () => {
    setHidden([])
    saveHiddenTypes(scope, [])
  }

  const types = visibleHidden.length
    ? available.filter((type) => !visibleHidden.includes(type))
    : null
  const search = useQuery({
    queryKey: ["global-search", debounced, types?.join(",") ?? "todo"],
    queryFn: () => {
      const params = new URLSearchParams({ q: debounced })
      if (types) params.set("tipos", types.join(","))
      return apiFetch<{ data: SearchResult }>(`/api/search?${params}`).then((body) => body.data)
    },
    enabled: debounced.length >= 2,
    placeholderData: keepPreviousData,
    staleTime: 15_000,
    retry: false,
  })

  const hrefOf = (target: SearchOwner["target"]) => targetHref(target, timeZone)
  /** Solo se ofrece abrir lo que este rol puede abrir; lo demás se lee aquí. */
  const opens = (target: SearchOwner["target"]) => canOpenHref(role, hrefOf(target))
  const go = (href: string, recent?: { id: string; title: string }) => {
    if (recent) rememberRecent(scope, recent)
    onClose()
    router.history.push(href)
  }
  const personRecent = (owner: SearchOwner) =>
    owner.kind === "persona" && owner.target.screen === "persona"
      ? { id: owner.id, title: owner.title }
      : undefined
  const openOwner = (owner: SearchOwner) => {
    if (opens(owner.target)) return go(hrefOf(owner.target), personRecent(owner))
    // Una respuesta del agente se copia para pegarla en la conversación.
    if (owner.text) {
      void navigator.clipboard?.writeText(owner.text).then(
        () => toast.success("Respuesta copiada"),
        () => toast.error("No se pudo copiar la respuesta"),
      )
    }
  }
  const openItem = (owner: SearchOwner, item: SearchItem) => {
    if (opens(item.target)) go(hrefOf(item.target), personRecent(owner))
  }
  const ownerVerb = (owner: SearchOwner) =>
    opens(owner.target) ? targetVerb(owner.target) : owner.text ? "Copiar respuesta" : null

  const text = query.trim()
  const typing = text.length >= 2
  const data = typing ? search.data : undefined
  const screenMatches = typing
    ? screens.filter((screen) => fold(screen.label).includes(fold(text))).slice(0, 4)
    : screens.slice(0, 6)
  // Al llegar resultados, la fila elegida es lo primero que se encontró (no la que quedó de antes).
  const firstValue = data?.owners[0]
    ? `dueño:${data.owners[0].key}`
    : data?.meaning[0]
      ? `dueño:${data.meaning[0].key}`
      : typing
        ? "preguntar-ayuda"
        : recents[0]
          ? `reciente:${recents[0].id}`
          : screens[0]
            ? `pantalla:${screens[0].to}`
            : ""
  const [selected, setSelected] = useState("")
  useEffect(() => setSelected(firstValue), [firstValue])
  const nothing =
    typing &&
    debounced === text &&
    !search.isFetching &&
    search.isSuccess &&
    !data?.owners.length &&
    !data?.meaning.length &&
    !screenMatches.length
  const canRegister = canAccess(role, "patients.write")
  const itemMeta = (item: SearchItem) =>
    [
      item.detail,
      item.amount ? formatSearchMoney(item.amount, locale) : null,
      item.at ? formatSearchWhen(item.at, locale, timeZone) : null,
    ]
      .filter(Boolean)
      .join(" · ")

  const renderOwner = (owner: SearchOwner) => {
    return (
      <div key={owner.key} className="mt-1" role="presentation">
        <CommandItem
          value={`dueño:${owner.key}`}
          onSelect={() => openOwner(owner)}
          className="gap-3 px-3 py-2"
        >
          <TypeTile type={owner.type} />
          <span className="flex min-w-0 flex-1 flex-col">
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate font-semibold">{owner.title}</span>
              <span className="shrink-0 rounded-full bg-muted px-2 py-px text-xs text-muted-foreground">
                {owner.badge}
              </span>
            </span>
            {owner.detail || owner.amount ? (
              <span className="truncate text-xs text-muted-foreground">
                {[owner.detail, owner.amount ? formatSearchMoney(owner.amount, locale) : null]
                  .filter(Boolean)
                  .join(" · ")}
              </span>
            ) : null}
          </span>
          {ownerVerb(owner) ? (
            <CommandShortcut className="hidden tracking-normal group-data-selected/command-item:sm:inline">
              Enter · {ownerVerb(owner)}
            </CommandShortcut>
          ) : (
            <CommandShortcut className="sr-only">solo lectura</CommandShortcut>
          )}
        </CommandItem>
        {owner.items.map((item) => (
          <CommandItem
            key={`${owner.key}:${item.kind}:${item.id}`}
            value={`cosa:${owner.key}:${item.kind}:${item.id}`}
            onSelect={() => openItem(owner, item)}
            className="gap-2 py-1 pr-3 pl-7"
          >
            <span
              aria-hidden="true"
              className="-mt-3 h-4 w-3.5 shrink-0 rounded-bl-md border-b-2 border-l-2 border-border"
            />
            <TypeTile type={item.type} size="sm" />
            <span className="w-24 shrink-0 text-xs font-semibold text-muted-foreground max-sm:w-auto">
              {SEARCH_KIND_LABELS[item.kind] ?? item.kind}
            </span>
            <span className="min-w-0 flex-1 truncate max-sm:whitespace-normal">{item.title}</span>
            <span className="shrink-0 text-xs text-muted-foreground max-sm:hidden">
              {itemMeta(item)}
            </span>
            {opens(item.target) ? (
              <CommandShortcut className="hidden tracking-normal group-data-selected/command-item:sm:inline">
                Enter · {targetVerb(item.target)}
              </CommandShortcut>
            ) : (
              <CommandShortcut className="sr-only">solo lectura</CommandShortcut>
            )}
          </CommandItem>
        ))}
        {owner.more > 0 ? (
          <CommandItem
            value={`mas:${owner.key}`}
            onSelect={() => openOwner(owner)}
            className="py-1 pr-3 pl-7 text-xs font-semibold text-primary"
          >
            <span
              aria-hidden="true"
              className="-mt-3 h-4 w-3.5 shrink-0 rounded-bl-md border-b-2 border-l-2 border-border"
            />
            + {owner.more} más de {owner.title}
            <CommandShortcut className="sr-only">ver</CommandShortcut>
          </CommandItem>
        ) : null}
      </div>
    )
  }

  return (
    <CommandDialog
      open
      onOpenChange={(next) => !next && onClose()}
      title="Buscar en todo"
      description="Personas, citas, mensajes, pagos, servicios y pantallas de la clínica"
      className="flex flex-col sm:max-w-2xl max-sm:inset-0 max-sm:top-0 max-sm:left-0 max-sm:h-dvh max-sm:max-w-none max-sm:translate-x-0 max-sm:rounded-none!"
    >
      <Command
        shouldFilter={false}
        loop
        value={selected}
        onValueChange={setSelected}
        className="flex h-full flex-col rounded-none! p-0"
      >
        <div className="flex items-center gap-2 border-b px-2 py-1">
          <CommandInput
            variant="lg"
            // Al abrir ya se puede escribir: la primera letra no se pierde.
            autoFocus
            value={query}
            onValueChange={setQuery}
            placeholder="Busca una persona, una cita, un pago, un servicio…"
            aria-label="Buscar en todo"
          />
          <Popover>
            <PopoverTrigger
              render={
                <Button
                  type="button"
                  variant={visibleHidden.length ? "secondary" : "ghost"}
                  size="sm"
                  className="shrink-0 gap-1.5 rounded-full"
                  aria-label={
                    visibleHidden.length
                      ? `Filtrar: ${available.length - visibleHidden.length} de ${available.length}`
                      : "Filtrar"
                  }
                />
              }
            >
              <ListFilter className="size-4" aria-hidden="true" />
              <span className="max-sm:sr-only">
                {visibleHidden.length
                  ? `Filtrar · ${available.length - visibleHidden.length} de ${available.length}`
                  : "Filtrar"}
              </span>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(30rem,calc(100vw-2rem))] p-2">
              <p className="px-2 pt-1 pb-2 text-xs font-semibold text-muted-foreground">
                Buscar en
              </p>
              <div className="grid grid-cols-1 gap-x-2 sm:grid-cols-2">
                {available.map((type) => {
                  const id = `buscar-en-${type}`
                  return (
                    <label
                      key={type}
                      htmlFor={id}
                      className="flex min-h-9 cursor-pointer items-center gap-2.5 rounded-md px-2 text-sm hover:bg-muted"
                    >
                      <Checkbox
                        id={id}
                        checked={!visibleHidden.includes(type)}
                        onCheckedChange={() => toggleType(type)}
                      />
                      <TypeTile type={type} size="sm" />
                      <span>{SEARCH_TYPE_LABELS[type]}</span>
                    </label>
                  )
                })}
              </div>
              <div className="mt-2 flex items-center justify-between border-t px-1 pt-2">
                <Button type="button" variant="link" size="sm" className="px-1" onClick={showAll}>
                  Marcar todo
                </Button>
                <span className="text-xs text-muted-foreground">Se recuerda la próxima vez.</span>
              </div>
            </PopoverContent>
          </Popover>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="shrink-0 sm:hidden"
            onClick={onClose}
          >
            Cerrar
          </Button>
          <Kbd className="max-sm:hidden">Esc</Kbd>
        </div>

        {visibleHidden.length ? (
          <div className="flex flex-wrap items-center gap-x-2 border-b bg-muted/40 px-4 py-1.5 text-xs text-muted-foreground">
            <span>
              Sin buscar en: {visibleHidden.map((type) => SEARCH_TYPE_LABELS[type]).join(", ")}
            </span>
            <Button
              type="button"
              variant="link"
              size="sm"
              className="h-auto px-1 py-0 text-xs"
              onClick={showAll}
            >
              Buscar en todo
            </Button>
          </div>
        ) : null}
        {typing && search.isError ? (
          <div
            role="status"
            className="m-2 flex items-center justify-between gap-3 rounded-md bg-warning-soft px-3 py-2 text-sm text-warning"
          >
            <span>
              {data
                ? "No pudimos actualizar la búsqueda. Mostramos lo último que encontramos."
                : "No pudimos buscar ahora."}
            </span>
            <Button type="button" size="sm" variant="outline" onClick={() => void search.refetch()}>
              Reintentar
            </Button>
          </div>
        ) : null}
        <p role="status" className="sr-only">
          {typing && data
            ? `${data.owners.filter((owner) => owner.kind === "persona").length} personas, ${
                data.owners.reduce((sum, owner) => sum + 1 + owner.items.length, 0) +
                data.meaning.length
              } resultados`
            : ""}
        </p>
        {typing && search.isFetching && data ? (
          <DataRefreshMarker message="Actualizando la búsqueda" className="mx-3" />
        ) : null}

        <CommandList className="max-h-[min(62vh,34rem)] flex-1 px-1 pb-2 max-sm:max-h-none">
          {!typing ? (
            <>
              {recents.length ? (
                <CommandGroup heading="Abiertas hace poco">
                  {recents.map((person) => (
                    <CommandItem
                      key={person.id}
                      value={`reciente:${person.id}`}
                      onSelect={() =>
                        go(hrefOf({ screen: "persona", personId: person.id }), person)
                      }
                      className="gap-3 px-3 py-2"
                    >
                      <TypeTile type="persona" />
                      <span className="min-w-0 flex-1 truncate font-medium">{person.title}</span>
                      <CommandShortcut className="hidden tracking-normal group-data-selected/command-item:sm:inline">
                        Enter · Abrir ficha
                      </CommandShortcut>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              <CommandGroup heading="Ir a">
                {screenMatches.map((screen) => (
                  <CommandItem
                    key={screen.to}
                    value={`pantalla:${screen.to}`}
                    onSelect={() => go(screen.to)}
                    className="px-3"
                  >
                    <ArrowRight className="text-muted-foreground" aria-hidden="true" />
                    {screen.label}
                    <CommandShortcut className="hidden tracking-normal group-data-selected/command-item:sm:inline">
                      Enter · Ir
                    </CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
              <p className="px-4 pt-2 text-xs text-muted-foreground">
                También por teléfono, documento o número de historia.
              </p>
            </>
          ) : null}

          {typing && !data && search.isFetching ? (
            <div className="space-y-2 p-3" aria-hidden="true">
              {[0, 1, 2].map((row) => (
                <div key={row} className="flex items-center gap-3">
                  <Skeleton className="size-9 rounded-lg" />
                  <div className="flex-1 space-y-1.5">
                    <Skeleton className="h-3.5 w-1/3" />
                    <Skeleton className="h-3 w-1/2" />
                  </div>
                </div>
              ))}
            </div>
          ) : null}

          {typing && data ? (
            <>
              {data.owners.map(renderOwner)}
              {data.meaning.length ? (
                <CommandGroup heading="Por lo que quisiste decir">
                  {data.meaning.map(renderOwner)}
                </CommandGroup>
              ) : null}
              {screenMatches.length ? (
                <CommandGroup heading="Ir a">
                  {screenMatches.map((screen) => (
                    <CommandItem
                      key={screen.to}
                      value={`pantalla:${screen.to}`}
                      onSelect={() => go(screen.to)}
                      className="px-3"
                    >
                      <ArrowRight className="text-muted-foreground" aria-hidden="true" />
                      {screen.label}
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
            </>
          ) : null}

          {nothing ? (
            <div className="space-y-3 px-4 py-6">
              <p className="text-sm">No encontramos «{text}».</p>
              <p className="text-xs text-muted-foreground">
                Revisa cómo se escribe o busca por teléfono o documento.
              </p>
              <div className="flex flex-wrap gap-2">
                {canRegister && !/\d{4,}/.test(text) ? (
                  <Button
                    type="button"
                    onClick={() => go(`/people?nuevo=${encodeURIComponent(text)}`)}
                  >
                    Crear paciente «{text}»
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}

          {typing ? (
            <CommandItem
              value="preguntar-ayuda"
              onSelect={() => {
                onClose()
                askHelp(text)
              }}
              className="mt-2 gap-3 px-3 py-2"
            >
              <span
                aria-hidden="true"
                className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground [&_svg]:size-[18px]"
              >
                <CircleHelp />
              </span>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">Preguntarle a Ayuda: «{text}»</span>
                <span className="text-xs text-muted-foreground">Abre Ayuda con esta pregunta</span>
              </span>
            </CommandItem>
          ) : null}
        </CommandList>

        <div className="flex items-center justify-between gap-4 border-t bg-muted/40 px-4 py-2 text-xs text-muted-foreground max-sm:hidden">
          <span>↑ ↓ moverse · Enter abrir · Esc cerrar</span>
          <span>Ctrl K abre y cierra</span>
        </div>
      </Command>
    </CommandDialog>
  )
}

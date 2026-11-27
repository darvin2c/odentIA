import { Button, cn, Popover, PopoverContent, PopoverTrigger } from "@odentia/ui"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import { brandColorCss } from "@odentia/ui/lib/brand-color"
import {
  AppShell,
  type AppShellNavEntry,
  Brand,
  EmptyState,
  PageHeader,
  PageShell,
  PlaceSwitcher,
  type ShellLinkComponent,
} from "@odentia/ui-patterns"
import {
  Banknote,
  Bot,
  ChartColumn,
  CircleHelp,
  Construction,
  House,
  Info,
  ListChecks,
  MessagesSquare,
  Package,
  ReceiptText,
  RotateCcw,
  Settings,
  Truck,
  UserRound,
} from "lucide-react"
import { ArgosPage, totales } from "./argos"
import { ClientesPage } from "./clientes"
import { ConversacionesPage } from "./conversaciones"
import { RUBRO_IDS, RUBROS } from "./datos"
import { planOf, reiniciar, useDb } from "./estado"
import { FichaPage } from "./ficha"
import { InicioPage } from "./inicio"
import { href, ir, useRuta } from "./ruta"

const HashLink: ShellLinkComponent = ({ to, className, children, title, onClick }) => (
  <a href={href(to)} className={className} title={title} onClick={onClick}>
    {children}
  </a>
)

const RECORRIDOS: [string, string][] = [
  ["1 · Clientas y sus grupos", "/clientes"],
  ["2 · La ficha de una clienta", "/clientes/c1"],
  ["3 · Lo que hizo Argos", "/argos"],
  ["4 · Lo que hará Argos", "/argos/hara"],
  ["5 · Reglas y presupuesto", "/argos/reglas"],
  ["6 · Chat: Rocío vuelve y compra", "/conversaciones/rocio"],
  ["7 · Chat: «ya no me mandes»", "/conversaciones/fio"],
  ["8 · Inicio: lo que espera a una persona", "/inicio"],
]

const BAR =
  "h-7 rounded-full px-3 text-[13px] text-white/75 hover:bg-white/10 hover:text-white data-pressed:bg-white data-pressed:text-[#18181b]"

/** La barra del prototipo: el rubro, el rol, los recorridos y volver a empezar. No es parte de gestorIA. */
function PrototypeBar() {
  const ruta = useRuta()
  return (
    <div className="sticky top-0 z-40 hidden h-11 items-center gap-3 border-b border-white/10 bg-[#18181b] px-4 text-[13px] text-white/80 md:flex">
      <span className="rounded-md bg-white/10 px-2 py-0.5 text-xs font-semibold tracking-wide text-white">
        Prototipo
      </span>
      <span className="text-white/60">Rubro</span>
      <ToggleGroup
        value={[ruta.rubro]}
        onValueChange={(v) => {
          const next = v[0]
          if (next)
            ir(ruta.path.startsWith("/clientes/") ? "/clientes" : ruta.path, {
              rubro: next as never,
            })
        }}
        className="gap-0.5"
        aria-label="Rubro de la tienda de ejemplo"
      >
        {RUBRO_IDS.map((r) => (
          <ToggleGroupItem key={r} value={r} className={BAR}>
            {RUBROS[r].label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <span className="ml-2 hidden text-white/60 xl:inline">Ver como</span>
      <ToggleGroup
        value={[ruta.ventas ? "ventas" : "dueno"]}
        onValueChange={(v) => {
          if (v[0]) ir(ruta.path, { ventas: v[0] === "ventas" })
        }}
        className="gap-0.5"
        aria-label="Ver como"
      >
        {[
          ["dueno", "Dueño"],
          ["ventas", "Ventas"],
        ].map(([v, l]) => (
          <ToggleGroupItem key={v} value={v!} className={BAR}>
            {l}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <span className="ml-auto flex items-center gap-1">
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="text-white/75 hover:bg-white/10 hover:text-white"
              />
            }
          >
            <ListChecks aria-hidden />
            Recorridos
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 gap-1 p-1.5">
            {RECORRIDOS.map(([l, p]) => (
              <a
                key={p}
                href={href(p)}
                className={cn(
                  "rounded-md px-2.5 py-2 text-sm outline-none hover:bg-muted focus-visible:bg-muted",
                  ruta.path === p && "bg-primary-soft text-primary-soft-foreground",
                )}
              >
                {l}
              </a>
            ))}
          </PopoverContent>
        </Popover>
        <Popover>
          <PopoverTrigger
            render={
              <Button
                variant="ghost"
                size="sm"
                className="text-white/75 hover:bg-white/10 hover:text-white"
              />
            }
          >
            <Info aria-hidden />
            Datos
          </PopoverTrigger>
          <PopoverContent align="end" className="w-80 text-sm">
            <p className="font-semibold">Todo es de ejemplo</p>
            <p className="text-muted-foreground">
              Tiendas, clientas, mensajes y resultados son de ejemplo, en memoria. Nada se envía. La
              tarifa de Meta es la que publica para Perú (S/ 0,2339 por promoción, desde el 1 de
              octubre de 2026). Fotos de Wikimedia Commons, recortadas.
            </p>
          </PopoverContent>
        </Popover>
        <Button
          variant="ghost"
          size="sm"
          className="text-white/75 hover:bg-white/10 hover:text-white"
          onClick={() => {
            reiniciar()
            ir("/clientes")
          }}
        >
          <RotateCcw aria-hidden />
          Empezar de nuevo
        </Button>
      </span>
    </div>
  )
}

function Pending({ title }: { title: string }) {
  return (
    <PageShell className="flex flex-col gap-6">
      <PageHeader title={title} />
      <EmptyState
        icon={Construction}
        title="Esta pantalla no es parte del prototipo"
        description="El prototipo muestra Clientes, Argos, las conversaciones de ejemplo e Inicio."
        actionLabel="Ir a Clientes"
        onAction={() => ir("/clientes")}
      />
    </PageShell>
  )
}

const TITLES: Record<string, string> = {
  "/despachos": "Despachos",
  "/pedidos": "Pedidos",
  "/catalogo": "Catálogo",
  "/caja": "Caja",
  "/reportes": "Reportes",
  "/configuracion": "Configuración",
  "/ayuda": "Ayuda",
}

export function App() {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const d = useDb(ruta.rubro)
  const owner = !ruta.ventas
  const t = totales(planOf(ruta.rubro), d)
  const p = ruta.path
  const items: AppShellNavEntry[] = [
    { label: "Inicio", to: "/inicio", icon: House },
    { label: "Despachos", to: "/despachos", icon: Truck },
    { label: "Pedidos", to: "/pedidos", icon: ReceiptText },
    { label: "Clientes", to: "/clientes", icon: UserRound },
    { label: "Conversaciones", to: "/conversaciones", icon: MessagesSquare },
    {
      label: "Gestión",
      children: [
        { label: "Catálogo", to: "/catalogo", icon: Package },
        ...(owner
          ? [
              {
                label: "Argos",
                to: "/argos",
                icon: Bot,
                ...(t.espera ? { badge: t.espera, badgeLabel: "esperan tu sí" } : {}),
              },
              { label: "Caja", to: "/caja", icon: Banknote },
              { label: "Reportes", to: "/reportes", icon: ChartColumn },
            ]
          : []),
      ],
    },
  ]
  const ficha = /^\/clientes\/(c\d+)$/.exec(p)?.[1]
  const chat = /^\/conversaciones\/(rocio|fio)$/.exec(p)?.[1] as "rocio" | "fio" | undefined
  let page: React.ReactNode
  if (p === "/clientes") page = <ClientesPage />
  else if (ficha) page = <FichaPage key={`${ruta.rubro}-${ficha}`} id={ficha} />
  else if (p === "/argos" || p === "/argos/hara" || p === "/argos/reglas")
    page = owner ? (
      <ArgosPage tab={p === "/argos" ? "hizo" : (p.slice(7) as "hara" | "reglas")} />
    ) : (
      <PageShell>
        <EmptyState
          icon={Bot}
          title="Argos lo ven el Dueño y el Administrador"
          description="Lo que Argos hace con cada clienta está en su ficha."
          actionLabel="Ir a Clientes"
          onAction={() => ir("/clientes")}
        />
      </PageShell>
    )
  else if (p === "/conversaciones" || chat)
    page = <ConversacionesPage key={`${ruta.rubro}-${chat ?? ""}`} inicial={chat} />
  else if (p === "/inicio") page = <InicioPage />
  else page = <Pending title={TITLES[p] ?? "gestorIA"} />
  const navPath = ficha
    ? "/clientes"
    : chat
      ? "/conversaciones"
      : p.startsWith("/argos")
        ? "/argos"
        : p

  const css = brandColorCss(R.store.color)
  return (
    <>
      {css ? <style>{css}</style> : null}
      <AppShell
        notice={<PrototypeBar />}
        items={items}
        LinkComponent={HashLink}
        pathname={navPath}
        user={{
          name: owner ? R.store.owner : R.store.ventas,
          email: owner ? R.store.mail : `ventas@${R.store.slug}.pe`,
          avatarUrl: null,
        }}
        userMenuItems={[]}
        footerItems={[
          ...(owner ? [{ label: "Configuración", to: "/configuracion", icon: Settings }] : []),
          { label: "Ayuda", to: "/ayuda", icon: CircleHelp },
        ]}
        brand={<Brand />}
        brandIcon={<Brand compact />}
        switcher={
          <PlaceSwitcher
            current={{
              id: ruta.rubro,
              name: R.store.name,
              brand: "gestoria",
              role: `${R.label} · ${owner ? "Dueño" : "Ventas"}`,
            }}
            places={RUBRO_IDS.map((r) => ({
              id: r,
              name: RUBROS[r].store.name,
              brand: "gestoria" as const,
              role: `${RUBROS[r].label} · ${owner ? "Dueño" : "Ventas"}`,
              href: href("/clientes", { rubro: r }),
            }))}
            actions={[
              {
                label: owner ? "Ver como Ventas" : "Ver como Dueño",
                icon: <UserRound aria-hidden />,
                onSelect: () => ir(p, { ventas: owner }),
              },
              {
                label: "Empezar de nuevo",
                icon: <RotateCcw aria-hidden />,
                onSelect: () => {
                  reiniciar()
                  ir("/clientes")
                },
              },
            ]}
            menuLabel="Menú de la tienda"
          />
        }
        signOutHint="En el prototipo no se cierra nada"
        onSignOut={() => ir("/clientes")}
      >
        <div className="min-w-0">{page}</div>
      </AppShell>
    </>
  )
}

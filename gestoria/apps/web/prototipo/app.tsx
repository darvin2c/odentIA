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
  ChartColumn,
  CircleHelp,
  Construction,
  House,
  Info,
  MessagesSquare,
  Package,
  ReceiptText,
  RotateCcw,
  Settings,
  Truck,
  UserRound,
} from "lucide-react"
import { CameraPage } from "./camara"
import { BulkPage } from "./cargar"
import { CatalogPage } from "./catalogo"
import { ChatsPage } from "./conversaciones"
import { CREDITOS, RUBRO_IDS, RUBROS } from "./datos"
import { ProductPage } from "./ficha/ficha"
import { href, ir, useRuta } from "./ruta"
import { reiniciar, useTienda } from "./tienda"
import { ClientaPage } from "./pedidos/clienta"
import { ComoAvanzaPage } from "./pedidos/como-avanza"
import { PedidoPage } from "./pedidos/detalle"
import { InicioPage } from "./pedidos/inicio"
import { PedidosPage } from "./pedidos/lista"
import { reiniciarPedidos, teToca, usePedidos } from "./pedidos/modelo"
import { RepartoPage } from "./pedidos/reparto"
import { PoliticaPage } from "./pedidos/vuelta-ui"

const HashLink: ShellLinkComponent = ({ to, className, children, title, onClick }) => (
  <a href={href(to)} className={className} title={title} onClick={onClick}>
    {children}
  </a>
)

/** La barra del prototipo: el rubro, el rol y volver a empezar. No es parte de gestorIA. */
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
            ir(ruta.path.startsWith("/catalogo/") ? "/catalogo" : ruta.path, {
              rubro: next as never,
            })
        }}
        className="gap-0.5"
        aria-label="Rubro de la tienda de ejemplo"
      >
        {RUBRO_IDS.map((r) => (
          <ToggleGroupItem
            key={r}
            value={r}
            className="h-7 rounded-full px-3 text-[13px] text-white/75 hover:bg-white/10 hover:text-white data-pressed:bg-white data-pressed:text-[#18181b]"
          >
            {RUBROS[r].label}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <span className="ml-2 text-white/60">Ver como</span>
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
          <ToggleGroupItem
            key={v}
            value={v!}
            className="h-7 rounded-full px-3 text-[13px] text-white/75 hover:bg-white/10 hover:text-white data-pressed:bg-white data-pressed:text-[#18181b]"
          >
            {l}
          </ToggleGroupItem>
        ))}
      </ToggleGroup>
      <span className="ml-2 text-white/60">Mirar</span>
      <ToggleGroup
        value={[ruta.path === "/clienta" ? "clienta" : ruta.path === "/reparto" ? "reparto" : "tienda"]}
        onValueChange={(v) => {
          if (v[0] === "clienta") ir("/clienta", { extra: "p=0165" })
          else if (v[0] === "reparto") ir("/reparto")
          else if (v[0]) ir("/pedidos")
        }}
        className="gap-0.5"
        aria-label="Mirar el pedido desde"
      >
        {[
          ["tienda", "La tienda"],
          ["clienta", "La clienta"],
          ["reparto", "El repartidor"],
        ].map(([v, l]) => (
          <ToggleGroupItem
            key={v}
            value={v!}
            className="h-7 rounded-full px-3 text-[13px] text-white/75 hover:bg-white/10 hover:text-white data-pressed:bg-white data-pressed:text-[#18181b]"
          >
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
            <Info aria-hidden />
            Fotos y datos
          </PopoverTrigger>
          <PopoverContent align="end" className="max-h-96 w-80 overflow-auto">
            <p className="font-semibold">Fotos de Wikimedia Commons, recortadas</p>
            <ul className="flex flex-col gap-1 text-xs text-muted-foreground">
              {CREDITOS.map((c) => (
                <li key={c}>{c}</li>
              ))}
            </ul>
            <p className="text-xs text-muted-foreground">
              Los videos están armados con estas fotos. Tiendas, clientas y cifras son de ejemplo;
              la IA y Sofi responden con reglas fijas.
            </p>
          </PopoverContent>
        </Popover>
        <Button
          variant="ghost"
          size="sm"
          className="text-white/75 hover:bg-white/10 hover:text-white"
          onClick={() => {
            reiniciar()
            reiniciarPedidos()
            ir("/pedidos")
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
        description="El prototipo muestra Inicio, los pedidos, el catálogo, la ficha del producto y las conversaciones de Sofi."
        actionLabel="Ir a Pedidos"
        onAction={() => ir("/pedidos")}
      />
    </PageShell>
  )
}

const TITLES: Record<string, string> = {
  "/inicio": "Inicio",
  "/despachos": "Despachos",
  "/pedidos": "Pedidos",
  "/clientes": "Clientes",
  "/caja": "Caja",
  "/reportes": "Reportes",
  "/configuracion": "Configuración",
  "/ayuda": "Ayuda",
}

export function App() {
  const ruta = useRuta()
  const rol = useTienda((s) => s.rol)
  const R = RUBROS[ruta.rubro]
  const owner = rol === "dueno"
  const tocaPedidos = teToca(usePedidos(ruta.rubro)).length
  const items: AppShellNavEntry[] = [
    { label: "Inicio", to: "/inicio", icon: House },
    { label: "Despachos", to: "/despachos", icon: Truck },
    {
      label: "Pedidos",
      to: "/pedidos",
      icon: ReceiptText,
      ...(tocaPedidos ? { badge: tocaPedidos, badgeLabel: "te necesitan" } : {}),
    },
    { label: "Clientes", to: "/clientes", icon: UserRound },
    {
      label: "Conversaciones",
      to: "/conversaciones",
      icon: MessagesSquare,
      badge: 1,
      badgeLabel: "espera una respuesta",
    },
    {
      label: "Gestión",
      children: [
        { label: "Catálogo", to: "/catalogo", icon: Package },
        ...(owner
          ? [
              { label: "Caja", to: "/caja", icon: Banknote },
              { label: "Reportes", to: "/reportes", icon: ChartColumn },
            ]
          : []),
      ],
    },
  ]
  const p = ruta.path
  const productId = /^\/catalogo\/(p[\w-]+)$/.exec(p)?.[1]
  const pedidoId = /^\/pedidos\/(\d{4})$/.exec(p)?.[1]
  let page: React.ReactNode
  if (p === "/inicio") page = <InicioPage />
  else if (p === "/pedidos") page = <PedidosPage />
  else if (p === "/pedidos/como-avanza") page = <ComoAvanzaPage />
  else if (p === "/pedidos/politica") page = <PoliticaPage key={ruta.rubro} />
  else if (pedidoId) page = <PedidoPage key={`${ruta.rubro}-${pedidoId}`} pid={pedidoId} />
  else if (p === "/clienta") page = <ClientaPage />
  else if (p === "/reparto") page = <RepartoPage />
  else if (p === "/catalogo") page = <CatalogPage />
  else if (p === "/catalogo/cargar") page = <BulkPage />
  else if (p === "/catalogo/camara") page = <CameraPage />
  else if (productId) page = <ProductPage key={`${ruta.rubro}-${productId}`} pid={productId} />
  else if (p === "/conversaciones") page = <ChatsPage />
  else page = <Pending title={TITLES[p] ?? "gestorIA"} />

  const css = brandColorCss(R.store.color)
  return (
    <>
      {css ? <style>{css}</style> : null}
      <AppShell
        notice={<PrototypeBar />}
        items={items}
        LinkComponent={HashLink}
        pathname={p}
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
              href: href("/catalogo", { rubro: r }),
            }))}
            actions={[
              {
                label: owner ? "Ver como Ventas" : "Ver como Dueño",
                icon: <UserRound aria-hidden />,
                onSelect: () => ir(p, { ventas: owner }),
              },
            ]}
            menuLabel="Menú de la tienda"
          />
        }
        signOutHint="En el prototipo no se cierra nada"
        onSignOut={() => ir("/catalogo")}
      >
        <div className={cn("min-w-0")}>{page}</div>
      </AppShell>
    </>
  )
}

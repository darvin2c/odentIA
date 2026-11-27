import { Button, cn, Popover, PopoverContent, PopoverTrigger } from "@odentia/ui"
import { ToggleGroup, ToggleGroupItem } from "@odentia/ui/components/toggle-group"
import { brandColorCss } from "@odentia/ui/lib/brand-color"
import {
  AppShell,
  type AppShellNavEntry,
  Brand,
  PlaceSwitcher,
  type ShellLinkComponent,
} from "@odentia/ui-patterns"
import { Bot, House, Info, ListChecks, MessagesSquare, RotateCcw, UserRound } from "lucide-react"
import { useEffect } from "react"
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

const RECORRIDOS: [string, string, boolean][] = [
  ["Clientas y sus grupos", "/clientes", false],
  ["La ficha: lo que Argos anotó", "/clientes/c1", false],
  ["La ficha: el encargo de Argos a Sofi", "/clientes/c3", false],
  ["Chat: Rocío vuelve y compra", "/conversaciones/rocio", false],
  ["Chat: «ya no me mandes»", "/conversaciones/fio", false],
  ["Inicio: lo que te toca", "/inicio", false],
  ["Argos: lo que hizo", "/argos", true],
  ["Argos: lo que hará", "/argos/hara", true],
  ["Argos: las campañas", "/argos/campanas", true],
  ["Argos: reglas y presupuesto", "/argos/reglas", true],
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
            {RECORRIDOS.filter(([, , dueno]) => !(dueno && ruta.ventas)).map(([l, p], i) => (
              <a
                key={p}
                href={href(p)}
                className={cn(
                  "rounded-md px-2.5 py-2 text-sm outline-none hover:bg-muted focus-visible:bg-muted",
                  ruta.path === p && "bg-primary-soft text-primary-soft-foreground",
                )}
              >
                {i + 1} · {l}
              </a>
            ))}
            {ruta.ventas ? (
              <p className="px-2.5 py-2 text-xs text-muted-foreground">
                Como Dueño se ven también las pantallas de Argos.
              </p>
            ) : null}
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
              Tiendas, clientas, campañas y resultados son de ejemplo, en memoria. Nada se envía. La
              tarifa de Meta es la que publica para Perú (S/ 0,2339 por promoción, desde el 1 de
              octubre de 2026). El menú muestra solo las pantallas del prototipo. Fotos de Wikimedia
              Commons, recortadas.
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

export function App() {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const d = useDb(ruta.rubro)
  const owner = !ruta.ventas
  const t = totales(planOf(ruta.rubro), d)
  const p = ruta.path
  const ficha = /^\/clientes\/(c\d+)$/.exec(p)?.[1]
  const chat = /^\/conversaciones\/(rocio|fio)$/.exec(p)?.[1] as "rocio" | "fio" | undefined
  const argos = p === "/argos" || /^\/argos\/(hara|campanas|reglas)$/.test(p)
  const conocida =
    p === "/clientes" ||
    !!ficha ||
    p === "/conversaciones" ||
    !!chat ||
    p === "/inicio" ||
    (argos && owner)
  // Lo que no existe en el prototipo, o Argos para Ventas: directo a Clientes, sin pantalla de por medio.
  useEffect(() => {
    if (!conocida) location.replace(href("/clientes"))
  }, [conocida])

  // Solo las pantallas del prototipo; Argos, para quien decide lo que cuesta.
  const items: AppShellNavEntry[] = [
    { label: "Inicio", to: "/inicio", icon: House },
    { label: "Clientes", to: "/clientes", icon: UserRound },
    { label: "Conversaciones", to: "/conversaciones", icon: MessagesSquare },
    ...(owner
      ? [
          {
            label: "Gestión",
            children: [
              {
                label: "Argos",
                to: "/argos",
                icon: Bot,
                ...(t.espera ? { badge: t.espera, badgeLabel: "esperan tu sí" } : {}),
              },
            ],
          },
        ]
      : []),
  ]
  let page: React.ReactNode
  if (ficha) page = <FichaPage key={`${ruta.rubro}-${ficha}`} id={ficha} />
  else if (argos && owner)
    page = (
      <ArgosPage tab={p === "/argos" ? "hizo" : (p.slice(7) as "hara" | "campanas" | "reglas")} />
    )
  else if (p === "/conversaciones" || chat)
    page = <ConversacionesPage key={`${ruta.rubro}-${chat ?? ""}`} inicial={chat} />
  else if (p === "/inicio") page = <InicioPage />
  else page = <ClientesPage />
  const navPath = ficha
    ? "/clientes"
    : chat
      ? "/conversaciones"
      : argos
        ? "/argos"
        : conocida
          ? p
          : "/clientes"

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
        footerItems={[]}
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
                onSelect: () => ir(argos ? "/clientes" : p, { ventas: owner }),
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

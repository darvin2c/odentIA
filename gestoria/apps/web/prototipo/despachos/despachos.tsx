import {
  Badge,
  Button,
  cn,
  Input,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Tabs,
  TabsList,
  TabsTrigger,
  toast,
} from "@odentia/ui"
import {
  EmptyState,
  FilterBar,
  ListSearchScope,
  PageHeader,
  PageNotice,
  PageShell,
  PersonAvatar,
  RadioChips,
  SideDockProvider,
  SideDockSlot,
  useIconSidebarWhileMounted,
  type ListSearchController,
  useMediaQuery,
  useScopedListSearch,
} from "@odentia/ui-patterns"
import {
  Banknote,
  CalendarCheck,
  Check,
  MoreHorizontal,
  Package,
  Repeat,
  Route,
  ScrollText,
  Truck,
  UserRound,
  X,
} from "lucide-react"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { llegaronATienda } from "../pedidos/cobros"
import { filtrosComunes, pasaFiltros, type Rep } from "../pedidos/filtros"
import { money, usePedidos } from "../pedidos/modelo"
import { ConRouter } from "../pedidos/router"
import { ir, useRuta } from "../ruta"
import {
  ArrastreProvider,
  type Destino,
  Flecha,
  TiraDias,
  useArrastrable,
  useArrastre,
} from "./gestos"
import { ScheduleSnapPager as Pager } from "@odentia/ui-patterns"
import { AccionCajon } from "../pedidos/cajon"
import { Hoja } from "../pedidos/hoja"
import { Cobro, FaltaHoja, Foto, mostrarCobro } from "./hojas"
import {
  CUPO,
  corto,
  type Ent,
  type Etapa,
  ETAPA,
  entregasDe,
  type Faltas,
  FERIADOS,
  FRANJA_NOMBRE,
  FRANJAS,
  HOY,
  largo,
  llena,
  necesita,
  ocupadas,
  ORDEN_ETAPAS,
  ordenar,
  plataDe,
  PUNTO,
  REPARTIDORES,
  semanaDe,
  sumar,
} from "./semana"

/**
 * Despachos, hecho para el dedo (lienzo «gestorIA · Despachos»). Lo decidido sigue igual: días,
 * franjas y repartidor; primero lo que no se entregó; «Pasar a…» para mover; el envío por agencia
 * con su número; y Caja recibe el efectivo. Lo nuevo:
 * - La semana se desliza (`ScheduleSnapPager`) y el día también: sigue al dedo y encaja.
 *   Las flechas, «Hoy» y tocar un día hacen lo mismo sin deslizar.
 * - Mantener una entrega y moverla a otro día, franja o repartidor abre «Pasar a…» ya lleno.
 * - Arriba, solo lo que necesita a una persona, con su único botón («Empacar»), que abre el cajón.
 * - Por franja o por repartidor; en escritorio, además, la semana entera.
 * v2 (lo pidió el dueño):
 * - Cada entrega muestra su etapa (la de Pedidos) y, aparte, el cobro. Arriba del día, la tira de
 *   etapas cuenta cuántas hay en cada una; tocar una filtra.
 * - Cada tarjeta va en dos filas: el pedido, y lo que toca (con su único botón o «Sigue solo»).
 * - Tocar la tarjeta o su botón abre siempre el cajón del pedido, con lo que toca fijo al pie.
 *   Soltar una entrega lo abre con «Pasar a…» ya lleno.
 * - Los recojos de cambios y devoluciones son una parada más del día.
 */

type Vista = "franja" | "rep"
type Hoja =
  | {
      k: "pedido"
      id: string
      /** Al soltar: lo que toca es «Pasar a…», ya lleno. */
      pasar?: { fecha?: string; franja?: string | null; rep?: string | null }
    }
  | { k: "falta"; rep: string }

const titulo = (fecha: string) =>
  `${largo(fecha).replace(/^./, (c) => c.toUpperCase())}${fecha === HOY ? " · hoy" : fecha === sumar(HOY, 1) ? " · mañana" : ""}`

function resumen(list: Ent[]) {
  const n = list.length
  const toca = list.filter(necesita).length
  return [
    n === 0 ? "Sin entregas" : `${n} ${n === 1 ? "entrega" : "entregas"}`,
    toca ? `${toca} te ${toca === 1 ? "toca" : "tocan"}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

/** Cuántas hay en cada etapa, en el orden del camino. */
function porEtapa(list: Ent[]) {
  return ORDEN_ETAPAS.map((et) => ({ et, n: list.filter((e) => e.etapa === et).length })).filter(
    (x) => x.n,
  )
}

/** El punto de color de una etapa, el de su Badge. */
export function Punto({ et, className }: { et: Etapa; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 shrink-0 rounded-full", PUNTO[ETAPA[et].tono], className)}
    />
  )
}

/**
 * La tira de etapas: con un vistazo, cuántas hay en cada una. Tocar una filtra el día; tocarla
 * otra vez, o «Todas», lo quita.
 */
function TiraEtapas({
  list,
  filtro,
  setFiltro,
}: {
  list: Ent[]
  filtro: Etapa | null
  setFiltro: (e: Etapa | null) => void
}) {
  const grupos = porEtapa(list)
  if (!grupos.length) return null
  return (
    <div
      role="group"
      aria-label="Etapa: toca una para ver solo esas; tócala otra vez para quitarla"
      className="-mx-4 flex gap-1.5 overflow-x-auto px-4 pb-1 [scrollbar-width:none] sm:mx-0 sm:flex-wrap sm:px-0"
    >
      <button
        type="button"
        aria-pressed={filtro === null}
        onClick={() => setFiltro(null)}
        className={cn(
          "flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring",
          filtro === null ? "border-foreground bg-foreground text-background" : "bg-card",
        )}
      >
        Todas <b className="tabular-nums">{list.length}</b>
      </button>
      {grupos.map(({ et, n }) => (
        <button
          key={et}
          type="button"
          aria-pressed={filtro === et}
          aria-label={filtro === et ? `Quitar el filtro: ${ETAPA[et].label}` : `${ETAPA[et].label}: ${n}`}
          onClick={() => setFiltro(filtro === et ? null : et)}
          className={cn(
            "flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border bg-card px-3.5 text-sm whitespace-nowrap outline-none focus-visible:ring-2 focus-visible:ring-ring",
            filtro === et && "border-primary bg-primary-soft font-medium",
          )}
        >
          <Punto et={et} />
          {ETAPA[et].label} <b className="tabular-nums">{n}</b>
          {filtro === et ? <X aria-hidden className="size-3.5" /> : null}
        </button>
      ))}
    </div>
  )
}

/** Los filtros de Despachos, para volver a ellos tal como estaban. */
const memo: { filtros: Record<string, string | undefined> } = { filtros: {} }

/**
 * Despachos con sus filtros: el mismo FilterBar de Pedidos (Repartidor, Cobro y Zona, con su
 * número) y la tira de etapas, que es el filtro Etapa. Valen en «Por franja», «Por repartidor» y la
 * semana de escritorio.
 */
export function DespachosPage() {
  const scope = useScopedListSearch(memo.filtros)
  useEffect(() => {
    memo.filtros = scope.search as typeof memo.filtros
  }, [scope.search])
  return <Despachos scope={scope} />
}

/**
 * El router en memoria (para el FilterBar) envuelve solo la barra: envolver toda la pantalla hacía
 * que el carrusel de días perdiera su lugar al cambiar el alto de la ventana.
 */
function Barra({ scope, children }: { scope: ListSearchController; children: ReactNode }) {
  return (
    <ConRouter>
      <ListSearchScope value={scope}>{children}</ListSearchScope>
    </ConRouter>
  )
}

function Despachos({ scope }: { scope: ListSearchController }) {
  const { rubro, q } = useRuta()
  const all = usePedidos(rubro)
  const ents = useMemo(() => entregasDe(all), [all])
  const [fecha, setFecha] = useState(q.get("dia") ?? HOY)
  const [vista, setVista] = useState<Vista>(q.get("vista") === "rep" ? "rep" : "franja")
  const ancho = useMediaQuery("(min-width: 1024px)")
  const [ver, setVer] = useState<"dia" | "semana">(q.get("ver") === "dia" ? "dia" : "semana")
  const [faltas, setFaltas] = useState<Faltas>(q.get("falta") ? { [HOY]: [q.get("falta")!] } : {})
  const [caja, setCaja] = useState<Record<string, Caja>>({})
  const [hoja, setHoja] = useState<Hoja | null>(
    q.get("hoja") === "falta"
      ? { k: "falta", rep: "Jhon" }
      : q.get("abrir")
        ? { k: "pedido", id: q.get("abrir")! }
        : null,
  )
  // La tira de etapas es el filtro Etapa: vive con los demás, y «Limpiar» también la quita.
  const { get, setParams, resetFilters } = scope
  const filtro = (get("etapa") as Etapa | undefined) ?? null
  const setFiltro = (et: Etapa | null) => setParams({ etapa: et ?? undefined })
  const fRep = get("rep") as Rep | undefined
  const busca = (get("q") ?? "").toLowerCase()
  const fCobro = get("cobro")
  const fZona = get("zona")
  const hayFiltro = !!(filtro || fRep || fCobro || fZona || busca)
  // Lo que se ve: todo menos la etapa, que se cuenta en la tira.
  const vis = useMemo(
    () =>
      ents.filter(
        (e) =>
          (!busca || `${e.p.id} ${e.p.clienta} ${e.p.telefono}`.toLowerCase().includes(busca)) &&
          pasaFiltros(e.p, { rep: fRep, cobro: fCobro, zona: fZona }),
      ),
    [ents, busca, fRep, fCobro, fZona],
  )
  // Un enlace con `?dia=` (desde Inicio o un caso del lienzo) abre ese día aunque ya esté abierto.
  const qDia = q.get("dia")
  const qVista = q.get("vista")
  useEffect(() => {
    if (qDia) {
      setFecha(qDia)
      setVer("dia")
    }
    if (qVista) setVista(qVista === "rep" ? "rep" : "franja")
  }, [qDia, qVista])
  const semana = ancho && ver === "semana"
  const lunes = semanaDe(fecha)[0]!
  const delDia = (f: string) => ents.filter((e) => e.fecha === f)
  const porId = (id: string) => ents.find((e) => e.id === id)

  // Tocar la tarjeta o su botón: siempre el cajón del pedido, con lo que toca al pie.
  const abrir = (e: Ent) => setHoja({ k: "pedido", id: e.id })
  const soltar = (id: string, d: Destino) => {
    const e = porId(id)
    if (!e) return
    if (["entregado", "en_camino"].includes(e.estado)) {
      toast.info(`${e.p.clienta.split(" ")[0]}: ya salió, no se mueve.`, {
        description: "Si no la encuentran, Kevin marca «No estaba» en su app y vuelve.",
      })
      return
    }
    const mismo =
      (d.fecha ?? e.fecha) === e.fecha &&
      (d.franja === undefined || d.franja === e.p.entrega.franja) &&
      (d.rep === undefined || d.rep === e.p.entrega.repartidor)
    if (mismo) return
    setHoja({
      k: "pedido",
      id,
      pasar: {
        fecha: d.fecha ?? e.fecha,
        franja: d.franja === undefined ? e.p.entrega.franja : d.franja,
        rep: d.rep === undefined ? undefined : (d.rep ?? undefined),
      },
    })
  }
  const describir = (d: Destino) =>
    [d.fecha ? largo(d.fecha) : null, d.franja ? FRANJA_NOMBRE[d.franja] : null, d.rep]
      .filter(Boolean)
      .join(", ")

  const carga = (f: string) => {
    const l = delDia(f)
    return {
      count: l.length,
      alerta: l.some((e) => e.estado === "no_entregado" || e.estado === "no_sale"),
      feriado: FERIADOS[f],
    }
  }
  const comun = { ents, vis, faltas, abrir, setHoja, caja, setCaja, filtro, fRep, hayFiltro, limpiar: resetFilters }
  // Cada opción con su número, sobre lo que se mira: el día o la semana.
  const enVista = (semana ? ents.filter((e) => semanaDe(lunes).includes(e.fecha)) : delDia(fecha)).map(
    (e) => e.p,
  )

  const h = hoja && hoja.k !== "falta" ? porId(hoja.id) : undefined
  return (
    // La columna lateral: en una ventana ancha, el cajón se abre al lado y no tapa el día.
    <SideDockProvider>
    <div className="flex min-w-0">
    <div className="min-w-0 flex-1">
    <ArrastreProvider
      onSoltar={soltar}
      onSemana={(dir) => setFecha((f) => sumar(f, 7 * dir))}
      describir={describir}
    >
      <PageShell className="flex flex-col gap-4 pb-24 lg:pb-8">
        <PageHeader
          title="Despachos"
          menu={[
            {
              label: "Cobros: pago al recibir",
              icon: <ScrollText aria-hidden />,
              onSelect: () => ir("/configuracion/cobros"),
            },
            {
              label: "Ver la app del repartidor",
              icon: <Route aria-hidden />,
              onSelect: () => ir("/reparto"),
            },
          ]}
        />
        <Barra scope={scope}>
          <FilterBar
            className="filtros-dedo"
            filters={filtrosComunes(enVista)}
            sortOptions={[]}
            searchLabel="Buscar en despachos"
            searchPlaceholder="Nombre o número"
          />
        </Barra>
        {/* La semana: deslizar, las flechas, «Hoy» o tocar un día. Queda arriba al bajar. */}
        <div className="sticky top-0 z-20 -mx-4 flex flex-col gap-2 bg-canvas/95 px-4 pt-1 pb-2 backdrop-blur sm:-mx-6 sm:px-6">
          <div className="flex items-center gap-1">
            <Flecha dir={-1} label="Semana anterior" onClick={() => setFecha(sumar(fecha, -7))} />
            <span
              className="min-w-0 flex-1 truncate text-center text-sm font-semibold"
              aria-live="polite"
            >
              {rango(lunes)}
            </span>
            <Flecha dir={1} label="Semana siguiente" onClick={() => setFecha(sumar(fecha, 7))} />
            <Button
              variant="outline"
              className="ml-1 h-11 rounded-full px-4"
              aria-label="Volver a hoy"
              disabled={fecha === HOY}
              onClick={() => setFecha(HOY)}
            >
              Hoy
            </Button>
            {ancho ? (
              <Tabs value={ver} onValueChange={(v) => setVer(v as never)} className="ml-3">
                <TabsList aria-label="Qué ver" className="group-data-horizontal/tabs:h-14">
                  <TabsTrigger value="semana">La semana</TabsTrigger>
                  <TabsTrigger value="dia">El día</TabsTrigger>
                </TabsList>
              </Tabs>
            ) : null}
          </div>
          {semana ? null : (
            <Pager
              aria-label="Semanas: desliza a la izquierda para la siguiente"
              position={lunes}
              onStep={(dir) => setFecha(sumar(fecha, 7 * dir))}
              paneClassName="px-0.5"
              renderPane={(o) => (
                <TiraDias
                  dates={semanaDe(sumar(lunes, 7 * o))}
                  value={fecha}
                  today={HOY}
                  onChange={(f) => {
                    setFecha(f)
                    window.scrollTo({ top: 0, behavior: "smooth" })
                  }}
                  load={carga}
                />
              )}
            />
          )}
        </div>

        {semana ? <MenuEnIconos /> : null}
        {semana ? (
          <TiraEtapas
            list={vis.filter((e) => semanaDe(lunes).includes(e.fecha))}
            filtro={filtro}
            setFiltro={setFiltro}
          />
        ) : null}
        {semana ? (
          <Pager
            aria-label="Semanas: desliza a la izquierda para la siguiente"
            position={lunes}
            onStep={(dir) => setFecha(sumar(fecha, 7 * dir))}
            renderPane={(o) => (
              <SemanaTablero
                lunes={sumar(lunes, 7 * o)}
                fecha={fecha}
                abrirDia={(f) => {
                  setFecha(f)
                  setVer("dia")
                }}
                {...comun}
              />
            )}
          />
        ) : (
          <>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div className="flex min-w-0 flex-col" aria-live="polite">
                <h2 className="text-lg font-semibold">{titulo(fecha)}</h2>
                <p className="text-sm text-muted-foreground">{resumen(delDia(fecha))}</p>
              </div>
              <Tabs
                value={vista}
                onValueChange={(v) => setVista(v as Vista)}
                className="w-full sm:w-auto"
              >
                <TabsList aria-label="Ordenar el día" className="w-full group-data-horizontal/tabs:h-14 sm:w-auto">
                  <TabsTrigger value="franja">Por franja</TabsTrigger>
                  <TabsTrigger value="rep">Por repartidor</TabsTrigger>
                </TabsList>
              </Tabs>
            </div>
            <TiraEtapas list={vis.filter((e) => e.fecha === fecha)} filtro={filtro} setFiltro={setFiltro} />
            <Pager
              aria-label="Días: desliza a la izquierda para el día siguiente"
              position={fecha}
              onStep={(dir) => setFecha(sumar(fecha, dir))}
              className="-mx-4 items-start sm:-mx-6"
              paneClassName="px-4 sm:px-6"
              renderPane={(o) => (
                <DiaPane
                  fecha={sumar(fecha, o)}
                  vista={vista}
                  angosto={hoja?.k === "pedido"}
                  {...comun}
                />
              )}
            />
          </>
        )}

        {fecha !== HOY ? (
          <Button
            className="fixed bottom-5 left-1/2 z-30 h-12 -translate-x-1/2 rounded-full px-6 shadow-lg lg:hidden"
            onClick={() => setFecha(HOY)}
          >
            <CalendarCheck aria-hidden />
            Volver a hoy
          </Button>
        ) : null}
      </PageShell>

      {hoja?.k === "pedido" && h ? (
        <AccionCajon
          key={JSON.stringify(hoja)}
          p={h.p}
          e={h}
          pasarA={hoja.pasar}
          dock={!semana}
          faltas={faltas}
          onClose={() => setHoja(null)}
          onFalta={(rep) => setHoja({ k: "falta", rep })}
        />
      ) : null}
      {hoja?.k === "falta" ? (
        <FaltaHoja
          rep={hoja.rep}
          faltas={faltas}
          setFaltas={setFaltas}
          onClose={() => setHoja(null)}
        />
      ) : null}
    </ArrastreProvider>
    </div>
    <SideDockSlot />
    </div>
    </SideDockProvider>
  )
}

/** «Gabriela S.»: el nombre y la inicial del apellido, para la semana. */
const nombreCorto = (n: string) => {
  const [a = "", b = ""] = n.split(" ")
  return b ? `${a} ${b[0]}.` : a
}

/** En la semana, el menú lateral queda en íconos mientras se mira (como la atención en odentIA). */
function MenuEnIconos() {
  useIconSidebarWhileMounted()
  return null
}

function rango(lunes: string) {
  const fin = sumar(lunes, 6)
  const m = (f: string) =>
    new Intl.DateTimeFormat("es-PE", { month: "short", timeZone: "UTC" })
      .format(new Date(`${f}T12:00:00Z`))
      .replace(".", "")
  const d = (f: string) => Number(f.slice(8))
  return m(lunes) === m(fin)
    ? `${d(lunes)} – ${d(fin)} ${m(fin)}`
    : `${d(lunes)} ${m(lunes)} – ${d(fin)} ${m(fin)}`
}

/** Lo que Caja recibió de un repartidor: cuánto y, si no cuadra, la diferencia y su motivo. */
interface Caja {
  monto: number
  diferencia: number
  motivo?: string
}

interface Comun {
  /** Todas las entregas: los cupos se cuentan sin filtros. */
  ents: Ent[]
  /** Las que pasan los filtros (menos la etapa, que se cuenta en la tira). */
  vis: Ent[]
  faltas: Faltas
  abrir: (e: Ent) => void
  filtro: Etapa | null
  fRep?: Rep
  hayFiltro: boolean
  limpiar: () => void
  setHoja: (h: Hoja) => void
  caja: Record<string, Caja>
  setCaja: (c: Record<string, Caja>) => void
}

/* ---------- El día ---------- */

function DiaPane({
  fecha,
  vista,
  ents,
  vis,
  faltas,
  abrir,
  setHoja,
  caja,
  setCaja,
  filtro,
  fRep,
  hayFiltro,
  limpiar: resetFilters,
  angosto,
}: Comun & { fecha: string; vista: Vista; angosto?: boolean }) {
  const todoElDia = ordenar(vis.filter((e) => e.fecha === fecha))
  const dia = filtro ? todoElDia.filter((e) => e.etapa === filtro) : todoElDia
  const hayAlgo = ents.some((e) => e.fecha === fecha)
  const toca = dia.filter(necesita)
  const noEntrego = dia.filter((e) => e.estado === "no_entregado")
  const feriado = FERIADOS[fecha]
  const pasado = fecha < HOY
  return (
    // Con el cajón al lado, el día va en una sola columna.
    <div
      className={cn(
        "flex flex-col gap-5",
        !angosto && "lg:grid lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)] lg:items-start lg:gap-6",
      )}
    >
      <div className={cn("flex flex-col gap-5", !angosto && "lg:sticky lg:top-40")}>
        {feriado ? (
          <PageNotice tone="aviso" label="Feriado">
            {largo(fecha).replace(/^./, (c) => c.toUpperCase())}: {feriado}. La tienda no reparte y
            Sofi no ofrece este día.
            {dia.length ? " Lo que se anotó antes, pásalo a otro día." : ""}
          </PageNotice>
        ) : null}
        {fRep === "Kevin" || fRep === "Jhon" ? (
          <RutaDe rep={fRep} fecha={fecha} dia={dia} abrir={abrir} />
        ) : null}
        {toca.length ? (
          <section
            aria-labelledby={`toca-${fecha}`}
            className="flex flex-col gap-2 rounded-2xl border border-warning/40 bg-warning-soft/50 p-3"
          >
            <h3 id={`toca-${fecha}`} className="px-1 text-sm font-semibold">
              Te toca · {toca.length}
            </h3>
            <ul className="flex flex-col gap-2">
              {toca.map((e) => (
                <Tarjeta key={e.id} e={e} abrir={abrir} />
              ))}
            </ul>
          </section>
        ) : dia.length && !pasado && !hayFiltro ? (
          <p className="flex items-center gap-2 rounded-2xl bg-success-soft px-4 py-3 text-sm text-success">
            <Check aria-hidden className="size-4" />
            Nada te toca este día: lo demás avanza solo.
          </p>
        ) : null}
        {vista === "franja" && noEntrego.length ? (
          <Seccion titulo="No se entregó" aviso n={noEntrego.length}>
            {noEntrego.map((e) => (
              <Tarjeta key={e.id} e={e} abrir={abrir} />
            ))}
          </Seccion>
        ) : null}
      </div>
      <div className="flex flex-col gap-5">
        {dia.length === 0 && hayFiltro && hayAlgo ? (
          <div className="flex flex-wrap items-center gap-3 rounded-xl border border-dashed px-3 py-2 text-sm text-muted-foreground">
            <span className="flex-1">
              Nada con estos filtros este día
              {filtro ? ` (etapa «${ETAPA[filtro].label}»)` : ""}.
            </span>
            <Button variant="outline" className="h-11" onClick={resetFilters}>
              <X aria-hidden />
              Limpiar los filtros
            </Button>
          </div>
        ) : dia.length === 0 ? (
          feriado ? null : (
            <EmptyState
              icon={Truck}
              title={pasado ? "Ese día no salió nada" : "Nada para entregar este día"}
              description="Lo pagado aparece aquí en su día. Mantén una entrega y suéltala en este día para pasarla."
            />
          )
        ) : vista === "franja" ? (
          <PorFranja
            fecha={fecha}
            dia={dia.filter((e) => e.estado !== "no_entregado")}
            ents={ents}
            faltas={faltas}
            abrir={abrir}
          />
        ) : (
          <PorRepartidor
            fecha={fecha}
            dia={dia}
            ents={ents}
            faltas={faltas}
            abrir={abrir}
            setHoja={setHoja}
            caja={caja}
            setCaja={setCaja}
            angosto={angosto}
          />
        )}
      </div>
    </div>
  )
}

function Seccion({
  titulo,
  n,
  extra,
  aviso,
  destino,
  children,
  cabeza,
  pie,
}: {
  titulo: string
  n?: number
  extra?: ReactNode
  aviso?: boolean
  destino?: Destino
  children: ReactNode
  cabeza?: ReactNode
  pie?: ReactNode
}) {
  const { activo, sobre } = useArrastre()
  const encima = destino && JSON.stringify(destino) === JSON.stringify(sobre)
  return (
    <section
      aria-label={`${titulo}${n !== undefined ? `, ${n}` : ""}`}
      data-destino={destino ? JSON.stringify(destino) : undefined}
      className={cn(
        "flex flex-col gap-2 rounded-2xl transition-[background-color,box-shadow] duration-150",
        activo && destino && "bg-muted/60 p-2 outline-2 outline-offset-0 outline-border outline-dashed",
        encima && "bg-primary-soft outline-primary outline-solid",
      )}
    >
      <div className="flex min-h-11 items-center gap-2 px-1">
        {cabeza}
        <h3 className={cn("text-sm font-semibold", aviso && "text-destructive")}>
          {titulo}
          {n !== undefined ? (
            <span className="ml-1.5 font-normal text-muted-foreground">{n}</span>
          ) : null}
        </h3>
        <span className="ml-auto flex items-center gap-1">{extra}</span>
      </div>
      {children}
      {pie}
    </section>
  )
}

/** «Tarde · Kevin · Ate»: la franja, quién lo lleva y el distrito. */
function donde(e: Ent) {
  const x = e.p.entrega
  const fr = x.franja ? (FRANJA_NOMBRE[x.franja]?.split(" · ")[0] ?? x.franja) : null
  const quien =
    x.tipo === "agencia"
      ? `${x.agencia}${x.numero ? ` N.º ${x.numero}` : ""}`
      : (x.repartidor ?? "sin repartidor")
  return [fr, quien, x.zona.split(",")[0]].filter(Boolean).join(" · ")
}

/** «Zapatilla Urbana · Negro · 38», y «+1» si lleva más. */
function lleva(e: Ent) {
  const va = e.p.lineas.filter((l) => !l.vuelve)
  const l = va[0] ?? e.p.lineas[0]
  if (!l) return ""
  return `${l.nombre} · ${l.variante}${va.length > 1 ? ` · +${va.length - 1}` : ""}`
}

/**
 * La tarjeta de una entrega, en dos filas. Arriba, el pedido: la foto, la clienta y el número, lo
 * que lleva, la etapa, el cobro, la franja, quién lo lleva y el distrito. Abajo, lo que toca: una
 * frase y, si toca a una persona, su único botón. Tocar cualquier parte abre el cajón del pedido.
 */
function Tarjeta({
  e,
  abrir,
  orden,
  compacta,
}: {
  e: Ent
  abrir: (e: Ent) => void
  orden?: number
  compacta?: boolean
}) {
  const x = e.p.entrega
  const et = ETAPA[e.etapa]
  const fantasma = () => (
    <span className="flex items-center gap-2">
      <Foto e={e} className="size-9" />
      <span className="flex min-w-0 flex-col gap-0.5 text-sm">
        <span className="flex items-center gap-1.5">
          <b className="truncate">{e.p.clienta}</b>
          <Badge variant={et.tono}>{et.corto}</Badge>
        </span>
        <span className="truncate text-xs text-muted-foreground">
          Suéltala en un día, una franja o un repartidor
        </span>
      </span>
    </span>
  )
  const { props, arrastrando, levantando } = useArrastrable(e.id, fantasma)
  const nombre = `${e.p.clienta}, pedido ${e.p.id}: ${et.label}, ${e.cobro.texto}${e.vuelto ? `, lleva vuelto de ${money(e.vuelto)}` : ""}, ${donde(e)}`
  if (compacta)
    return (
      <button
        type="button"
        {...props}
        onClick={() => abrir(e)}
        aria-label={`${nombre}. ${e.toca.texto}`}
        className={cn(
          "flex min-h-12 w-full touch-manipulation items-start gap-1.5 rounded-lg border bg-card p-1.5 text-left text-xs outline-none select-none [-webkit-touch-callout:none] hover:border-primary focus-visible:ring-2 focus-visible:ring-ring",
          e.etapa === "entregado" && "opacity-60",
          e.etapa === "no_entregado" && "border-destructive/50",
          necesita(e) && "border-warning",
          arrastrando && "opacity-30",
        )}
      >
        <Foto e={e} className="size-8 rounded-md" />
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-semibold">{nombreCorto(e.p.clienta)}</span>
          <span className="flex items-center gap-1 truncate">
            <Punto et={e.etapa} />
            <span className="truncate">{et.corto}</span>
          </span>
          <span className="truncate text-muted-foreground">
            <Cobro e={e} corto className="font-normal" />
            {x.repartidor ? `${mostrarCobro(e) ? " · " : ""}${x.repartidor}` : ""}
          </span>
        </span>
      </button>
    )
  const persona = !!e.boton
  return (
    // Toda la tarjeta abre el cajón; con el teclado, la primera fila y el botón son los botones.
    // biome-ignore lint/a11y/useKeyWithClickEvents: el teclado usa los botones de adentro.
    <li
      {...props}
      onClick={() => abrir(e)}
      className={cn(
        "flex list-none touch-manipulation flex-col overflow-hidden rounded-xl border bg-card select-none [-webkit-touch-callout:none] transition-[transform,box-shadow,opacity] duration-200 hover:border-primary",
        e.etapa === "entregado" && "bg-card/60",
        e.etapa === "no_entregado" && "border-destructive/40",
        levantando && "motion-safe:scale-[0.98]",
        arrastrando && "opacity-30",
      )}
    >
      <button
        type="button"
        aria-label={`Abrir: ${nombre}`}
        className="flex w-full items-start gap-3 p-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
      >
        {orden ? (
          <span
            aria-label={`Parada ${orden}`}
            className="mt-3 flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold tabular-nums"
          >
            {orden}
          </span>
        ) : null}
        <Foto e={e} className={cn(e.etapa === "entregado" && "opacity-60")} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-baseline gap-1.5">
            <span className="truncate font-semibold">{e.p.clienta}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{e.p.id}</span>
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
            <Badge variant={et.tono}>{et.label}</Badge>
            <Cobro e={e} corto />
            {e.vuelto ? (
              <span className="inline-flex items-center gap-1 rounded-md bg-warning-soft px-1.5 font-medium">
                <Banknote aria-hidden className="size-3.5" />
                Lleva vuelto de {money(e.vuelto)}
              </span>
            ) : null}
          </span>
          <span className="flex items-center gap-1 truncate text-[13px]">
            {e.recojo ? (
              <Repeat aria-hidden className="size-3.5 shrink-0 text-primary" />
            ) : null}
            <span className="truncate">
              {e.recojo
                ? e.recojo.tipo === "cambio"
                  ? `Cambio de talla · ${e.recojo.lleva?.split(" · ").slice(1).join(" · ")}`
                  : `Devolución · ${e.recojo.recoge.split(",")[0]}`
                : lleva(e)}
            </span>
          </span>
          <span className="truncate text-[13px] text-muted-foreground">{donde(e)}</span>
        </span>
      </button>
      <div
        className={cn(
          "flex flex-wrap items-center gap-x-3 gap-y-2 border-t px-2.5 py-2",
          persona ? "bg-warning-soft/60" : "bg-muted/40",
        )}
      >
        <p className="flex min-w-[11rem] flex-1 items-start gap-1.5 text-[13px] leading-snug">
          {persona ? (
            <UserRound aria-hidden className="mt-0.5 size-3.5 shrink-0 text-warning" />
          ) : (
            <Check aria-hidden className="mt-0.5 size-3.5 shrink-0 text-success" />
          )}
          <span className={persona ? "" : "text-muted-foreground"}>
            {e.etapa === "no_entregado" ? <b className="text-destructive">Vuelve. </b> : null}
            {e.toca.texto}
          </span>
        </p>
        {e.boton ? (
          <Button
            type="button"
            className="ml-auto h-11 shrink-0 px-4 whitespace-nowrap"
            aria-label={`${e.boton.texto}: ${e.p.clienta}`}
          >
            {e.boton.texto}
          </Button>
        ) : null}
      </div>
    </li>
  )
}

/**
 * Al elegir un repartidor: su ruta del día en orden y lo que cobra en la puerta, con el vuelto que
 * tiene que llevar. Es la misma lista que ve en gestorIA Reparto.
 */
function RutaDe({ rep, fecha, dia, abrir }: { rep: string; fecha: string; dia: Ent[]; abrir: (e: Ent) => void }) {
  const ruta = dia.filter((e) => e.p.entrega.repartidor === rep)
  const sigue = ruta.filter((e) => !["entregado", "recogido", "en_tienda"].includes(e.etapa) && !e.p.rechazo)
  const cobra = sigue.filter((e) => e.p.cobro === "al_recibir").reduce((a, e) => a + e.falta, 0)
  const vuelto = sigue.reduce((a, e) => a + e.vuelto, 0)
  return (
    <section aria-labelledby={`ruta-${fecha}`} className="flex flex-col gap-2 rounded-2xl border bg-card p-3">
      <div className="flex items-center gap-2 px-1">
        <PersonAvatar name={rep} className="size-8" />
        <h3 id={`ruta-${fecha}`} className="text-sm font-semibold">
          La ruta de {rep}
          <span className="ml-1.5 font-normal text-muted-foreground">
            {ruta.length} {ruta.length === 1 ? "parada" : "paradas"}
          </span>
        </h3>
      </div>
      {ruta.length ? (
        <ol className="flex flex-col divide-y rounded-xl border">
          {ruta.map((e, i) => (
            <li key={e.id}>
              <button
                type="button"
                onClick={() => abrir(e)}
                aria-label={`Parada ${i + 1}: ${e.p.clienta}, ${ETAPA[e.etapa].label}, ${e.cobro.texto}${e.vuelto ? `, lleva vuelto de ${money(e.vuelto)}` : ""}`}
                className="flex min-h-12 w-full items-center gap-2.5 px-2.5 py-2 text-left text-sm outline-none hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
              >
                <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold tabular-nums">
                  {i + 1}
                </span>
                <span className="flex min-w-0 flex-1 flex-col">
                  <span className="flex items-center gap-1.5 truncate">
                    <Punto et={e.etapa} />
                    <b className="truncate font-medium">{e.p.clienta}</b>
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {[e.p.entrega.franja ? FRANJA_NOMBRE[e.p.entrega.franja]?.split(" · ")[0] : null, e.p.entrega.zona.split(",")[0], ETAPA[e.etapa].corto]
                      .filter(Boolean)
                      .join(" · ")}
                  </span>
                </span>
                <span className="flex shrink-0 flex-col items-end text-xs">
                  <Cobro e={e} corto />
                  {e.vuelto ? <span className="text-muted-foreground">vuelto {money(e.vuelto)}</span> : null}
                </span>
              </button>
            </li>
          ))}
        </ol>
      ) : (
        <p className="rounded-xl border border-dashed px-3 py-3 text-sm text-muted-foreground">
          {rep} no tiene paradas con estos filtros.
        </p>
      )}
      {cobra || vuelto ? (
        <dl className="flex flex-col gap-1 rounded-xl bg-muted/70 px-3 py-2 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-muted-foreground">Cobra en la puerta</dt>
            <dd className="font-semibold tabular-nums">{money(cobra)}</dd>
          </div>
          {vuelto ? (
            <div className="flex justify-between gap-3">
              <dt className="text-muted-foreground">Sale con vuelto</dt>
              <dd className="font-semibold tabular-nums">{money(vuelto)}</dd>
            </div>
          ) : null}
        </dl>
      ) : null}
    </section>
  )
}

function PorFranja({
  fecha,
  dia,
  ents,
  faltas,
  abrir,
}: {
  fecha: string
  dia: Ent[]
  ents: Ent[]
  faltas: Faltas
  abrir: (e: Ent) => void
}) {
  const grupos: { titulo: string; franja: string | null; lista: Ent[] }[] = [
    ...FRANJAS.map((f) => ({
      titulo: FRANJA_NOMBRE[f] ?? f,
      franja: f as string | null,
      lista: dia.filter((e) => e.p.entrega.franja === f),
    })),
    {
      titulo: "Por agencia o sin franja",
      franja: null,
      lista: dia.filter((e) => !e.p.entrega.franja),
    },
  ]
  return (
    <>
      {grupos
        .filter((g) => g.franja || g.lista.length)
        .map((g) => {
          const lleno = g.franja ? llena(ents, fecha, g.franja, faltas) : false
          const libres = g.franja
            ? REPARTIDORES.filter((r) => !(faltas[fecha] ?? []).includes(r)).reduce(
                (a, r) => a + Math.max(0, CUPO - ocupadas(ents, fecha, g.franja, r)),
                0,
              )
            : 0
          return (
            <Seccion
              key={g.titulo}
              titulo={g.titulo}
              n={g.lista.length}
              destino={{ fecha, franja: g.franja }}
              extra={
                g.franja && fecha >= HOY ? (
                  lleno ? (
                    <Badge variant="warning">Llena</Badge>
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {libres} {libres === 1 ? "lugar" : "lugares"}
                    </span>
                  )
                ) : null
              }
            >
              {g.lista.length ? (
                <ul className="flex flex-col gap-2">
                  {g.lista.map((e) => (
                    <Tarjeta key={e.id} e={e} abrir={abrir} />
                  ))}
                </ul>
              ) : (
                <p className="rounded-xl border border-dashed px-3 py-3 text-sm text-muted-foreground">
                  Nada en esta franja.
                </p>
              )}
            </Seccion>
          )
        })}
    </>
  )
}

function PorRepartidor({
  fecha,
  dia,
  faltas,
  abrir,
  setHoja,
  caja,
  setCaja,
  angosto,
}: {
  angosto?: boolean
  fecha: string
  dia: Ent[]
  ents: Ent[]
  faltas: Faltas
  abrir: (e: Ent) => void
  setHoja: (h: Hoja) => void
  caja: Record<string, Caja>
  setCaja: (c: Record<string, Caja>) => void
}) {
  const hoy = fecha === HOY
  // «Recibí» también se confirma: a quién, cuánto y de cuántas entregas.
  const { rubro } = useRuta()
  const [recibir, setRecibir] = useState<Recibir | null>(null)
  const grupos = [
    ...REPARTIDORES.map((r) => ({
      rep: r as string | null,
      titulo: r as string,
      lista: dia.filter((e) => e.p.entrega.repartidor === r),
    })),
    { rep: null, titulo: "Por agencia", lista: dia.filter((e) => e.p.entrega.tipo === "agencia") },
    {
      rep: null,
      titulo: "Sin repartidor",
      lista: dia.filter((e) => e.p.entrega.tipo !== "agencia" && !e.p.entrega.repartidor),
    },
  ].filter((g) => g.lista.length || (g.rep && hoy))
  return (
    <div className={cn("flex flex-col gap-5", !angosto && "xl:grid xl:grid-cols-2 xl:items-start")}>
      {grupos.map((g) => {
        const falta = g.rep ? (faltas[fecha] ?? []).includes(g.rep) : false
        const plata = g.rep ? plataDe(dia, g.rep) : null
        const recibido = g.rep ? caja[g.rep] : undefined
        const pendientes = g.lista.filter((e) => e.estado !== "entregado").length
        return (
          <Seccion
            key={g.titulo}
            titulo={g.titulo}
            n={g.lista.length}
            destino={g.rep ? { fecha, rep: g.rep } : undefined}
            cabeza={
              g.rep ? (
                <PersonAvatar name={g.rep} className="size-8" />
              ) : (
                <Package aria-hidden className="size-5 text-muted-foreground" />
              )
            }
            extra={
              g.rep && hoy && !falta ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-11"
                        aria-label={`Más sobre ${g.rep}`}
                      />
                    }
                  >
                    <MoreHorizontal aria-hidden />
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      className="min-h-11"
                      onClick={() => setHoja({ k: "falta", rep: g.rep! })}
                    >
                      {g.rep} no viene hoy
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : falta ? (
                <Badge variant="warning">No vino</Badge>
              ) : null
            }
            pie={
              g.rep && plata && hoy && !falta ? (
                <div className="flex flex-col gap-2 rounded-xl bg-muted/70 p-3 text-sm">
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Cobra en la puerta</span>
                    <b className="tabular-nums">{money(plata.porCobrar)}</b>
                  </div>
                  {plata.vuelto ? (
                    <div className="flex justify-between gap-3">
                      <span className="text-muted-foreground">Sale con vuelto</span>
                      <b className="tabular-nums">{money(plata.vuelto)}</b>
                    </div>
                  ) : null}
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Ya cobró en efectivo</span>
                    <b className="tabular-nums">{money(plata.cobrado)}</b>
                  </div>
                  {plata.pos || plata.yape ? (
                    <div className="flex justify-between gap-3 text-muted-foreground">
                      <span>Con POS · con Yape o Plin</span>
                      <span className="tabular-nums">
                        {money(plata.pos)} · {money(plata.yape)}
                      </span>
                    </div>
                  ) : null}
                  {recibido !== undefined ? (
                    <p className="flex items-start gap-2 text-success">
                      <Check aria-hidden className="mt-0.5 size-4 shrink-0" />
                      <span>
                        Caja recibió {money(recibido.monto)} de {g.rep}.
                        {recibido.diferencia ? (
                          <span className="block text-warning">
                            {recibido.diferencia < 0 ? "Faltan" : "Sobran"} {money(Math.abs(recibido.diferencia))}:{" "}
                            {recibido.motivo}
                          </span>
                        ) : null}
                      </span>
                    </p>
                  ) : (
                    <>
                      {plata.entrega !== plata.cobrado ? (
                        <p className="rounded-lg bg-warning-soft px-2.5 py-1.5 text-[13px]">
                          {g.rep} cerró su día: entrega {money(plata.entrega)}, {money(Math.abs(plata.entrega - plata.cobrado))}{" "}
                          {plata.entrega < plata.cobrado ? "menos" : "más"}. Dice: «{plata.motivo}»
                        </p>
                      ) : null}
                      <Button
                        variant={pendientes ? "outline" : "default"}
                        className="h-11"
                        disabled={plata.cobrado === 0}
                        onClick={() =>
                          setRecibir({
                            rep: g.rep!,
                            efectivo: plata.cobrado,
                            pos: plata.pos,
                            yape: plata.yape,
                            entrega: plata.entrega,
                            motivo: plata.motivo,
                            pendientes,
                            vuelven: plata.vuelven,
                          })
                        }
                      >
                        Recibí {money(plata.entrega)} de {g.rep}
                      </Button>
                    </>
                  )}
                </div>
              ) : null
            }
          >
            {falta ? (
              <p className="rounded-xl border border-dashed px-3 py-3 text-sm text-muted-foreground">
                Hoy no vino. Sus entregas ya se repartieron.
              </p>
            ) : g.lista.length ? (
              <ol className="flex flex-col gap-2">
                {g.lista.map((e, i) => (
                  <Tarjeta key={e.id} e={e} abrir={abrir} orden={g.rep ? i + 1 : undefined} />
                ))}
              </ol>
            ) : (
              <p className="rounded-xl border border-dashed px-3 py-3 text-sm text-muted-foreground">
                Nada asignado.
              </p>
            )}
          </Seccion>
        )
      })}
      {recibir ? (
        <RecibirHoja
          r={recibir}
          onClose={() => setRecibir(null)}
          onHecho={(c) => {
            setCaja({ ...caja, [recibir.rep]: c })
            llegaronATienda(rubro, recibir.rep)
            toast.success(`Quedó en Caja: ${money(c.monto)} de ${recibir.rep}.`, {
              description: c.diferencia
                ? `${c.diferencia < 0 ? "Faltan" : "Sobran"} ${money(Math.abs(c.diferencia))}: ${c.motivo?.replace(/\.$/, "")}. Queda anotado en Caja.`
                : recibir.pendientes
                  ? `Le quedan ${recibir.pendientes} por entregar; lo que cobre después se suma aparte.`
                  : "Cerró su día.",
            })
            setRecibir(null)
          }}
        />
      ) : null}
    </div>
  )
}

interface Recibir {
  rep: string
  efectivo: number
  pos: number
  yape: number
  /** Lo que dice que entrega al cerrar su día. */
  entrega: number
  motivo?: string
  pendientes: number
  vuelven: Ent[]
}

const MOTIVOS_DIF = ["Dio vuelto de más", "Pagó con otro medio", "Un billete falso o roto", "Aún no se sabe"]

/**
 * El cierre del repartidor: cuánto cobró con cada medio, cuánto entrega a Caja y, si no cuadra, la
 * diferencia (falta o sobra) con su motivo. Lo que trae de vuelta queda en la tienda.
 */
function RecibirHoja({ r, onClose, onHecho }: { r: Recibir; onClose: () => void; onHecho: (c: Caja) => void }) {
  const [contado, setContado] = useState(String(r.entrega))
  const n = Number(contado.replace(",", ".")) || 0
  const dif = Math.round((n - r.efectivo) * 100) / 100
  const delRep = r.motivo ? `Lo que dice ${r.rep}` : null
  const [motivo, setMotivo] = useState<string>(delRep ?? MOTIVOS_DIF[0]!)
  const fila = (k: string, v: ReactNode, fuerte?: boolean) => (
    <div className="flex justify-between gap-3 px-3 py-2.5">
      <dt className="text-muted-foreground">{k}</dt>
      <dd className={cn("text-right tabular-nums", fuerte ? "font-heading text-lg font-bold" : "font-medium")}>{v}</dd>
    </div>
  )
  return (
    <Hoja
      open
      dock={false}
      onClose={onClose}
      title={`Recibir la plata de ${r.rep}`}
      description="Lo que cobró hoy en la puerta. El efectivo queda en Caja a su nombre."
      submitLabel={`Recibí ${money(n)}${dif ? ` · ${dif < 0 ? "faltan" : "sobran"} ${money(Math.abs(dif))}` : ""}`}
      onSubmit={(ev) => {
        ev.preventDefault()
        onHecho({
          monto: n,
          diferencia: dif,
          motivo: dif ? (motivo === delRep ? `${r.motivo}` : motivo) : undefined,
        })
      }}
    >
      <dl className="flex flex-col divide-y rounded-xl border text-sm">
        {fila("Cobró en efectivo", money(r.efectivo))}
        {fila("Con POS (va a la cuenta)", money(r.pos))}
        {fila("Con Yape o Plin a la tienda", money(r.yape))}
        {fila("Tendría que entregar a Caja", money(r.efectivo), true)}
        {r.entrega !== r.efectivo ? fila(`${r.rep} dice que entrega`, money(r.entrega)) : null}
        {fila("Le quedan", r.pendientes ? `${r.pendientes} por entregar` : "Nada: cerró su día")}
        {r.vuelven.length
          ? fila(
              "Trae de vuelta",
              r.vuelven.map((e) => `${e.p.id} · ${e.p.clienta.split(" ")[0]} (${e.p.rechazo?.motivo.toLowerCase()})`).join(", "),
            )
          : null}
      </dl>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Contaste</span>
        <span className="flex items-center gap-2">
          S/
          <Input
            inputMode="decimal"
            value={contado}
            onChange={(ev) => setContado(ev.target.value)}
            className="h-11 w-32 tabular-nums"
            aria-describedby="dif-caja"
          />
        </span>
      </label>
      {dif ? (
        <div id="dif-caja" className="flex flex-col gap-2 rounded-xl border border-warning/50 bg-warning-soft/60 p-3 text-sm" role="status">
          <b>
            {dif < 0 ? "Faltan" : "Sobran"} {money(Math.abs(dif))} frente a lo que cobró en efectivo.
          </b>
          {r.motivo ? <span>{r.rep} dice: «{r.motivo}»</span> : null}
          <span id="motivo-dif" className="text-xs font-medium">
            El motivo
          </span>
          <div className="max-sm:[&_label]:min-h-11 pointer-coarse:[&_label]:min-h-11">
          <RadioChips
            aria-labelledby="motivo-dif"
            value={motivo}
            options={[...(delRep ? [delRep] : []), ...MOTIVOS_DIF].map((m) => ({ value: m, label: m }))}
            onChange={setMotivo}
          />
          </div>
          <span className="text-xs text-muted-foreground">Queda anotado en Caja con el nombre de {r.rep}.</span>
        </div>
      ) : (
        <p id="dif-caja" className="text-sm text-muted-foreground">
          Cuadra con lo que cobró. Cuéntalo antes de confirmar.
        </p>
      )}
    </Hoja>
  )
}

/* ---------- La semana entera (escritorio) ---------- */

function SemanaTablero({
  lunes,
  fecha,
  ents: todas,
  vis,
  filtro,
  faltas,
  abrir,
  abrirDia,
}: Comun & { lunes: string; fecha: string; abrirDia: (f: string) => void }) {
  const ents = filtro ? vis.filter((e) => e.etapa === filtro) : vis
  const dias = semanaDe(lunes)
  const filas: { titulo: string; franja: string | null }[] = [
    ...FRANJAS.map((f) => ({ titulo: FRANJA_NOMBRE[f] ?? f, franja: f as string | null })),
    { titulo: "Agencia o sin franja", franja: null },
  ]
  const toca = ordenar(ents.filter((e) => dias.includes(e.fecha) && necesita(e)))
  const { activo, sobre } = useArrastre()
  return (
    <div className="flex flex-col gap-4">
      {toca.length ? (
        <Button
          variant="outline"
          className="h-11 self-start border-warning/50 bg-warning-soft/60"
          onClick={() =>
            document.getElementById("te-toca-semana")?.scrollIntoView({ behavior: "smooth" })
          }
        >
          <UserRound aria-hidden className="text-warning" />
          Te toca esta semana: {toca.length}
        </Button>
      ) : null}
      <div
        role="grid"
        aria-label="La semana por franja"
        className="grid grid-cols-[4.5rem_repeat(7,minmax(0,1fr))] gap-1.5"
      >
        <span />
        {dias.map((d) => {
          const l = ents.filter((e) => e.fecha === d)
          const fer = FERIADOS[d]
          return (
            <button
              key={d}
              type="button"
              onClick={() => abrirDia(d)}
              aria-label={`Abrir el ${largo(d)}: ${fer ? `feriado, ${fer}` : resumen(l)}`}
              className={cn(
                "flex min-h-14 flex-col items-start justify-center rounded-xl border px-2.5 py-1.5 text-left outline-none hover:border-primary focus-visible:ring-2 focus-visible:ring-ring",
                d === HOY ? "border-primary bg-primary-soft" : "bg-card",
                d === fecha && d !== HOY && "border-primary",
                fer && "border-dashed bg-muted/60",
              )}
            >
              <span className="text-sm font-semibold capitalize">
                {corto(d)}
                {d === HOY ? " · hoy" : ""}
              </span>
              <span className="text-xs text-muted-foreground">
                {fer
                  ? `Feriado`
                  : l.length
                    ? `${l.length} ${l.length === 1 ? "entrega" : "entregas"}`
                    : "—"}
              </span>
              {l.length && !fer ? (
                <span className="mt-1 flex h-1.5 w-full gap-px overflow-hidden rounded-full" aria-hidden>
                  {porEtapa(l).map(({ et, n }) => (
                    <span
                      key={et}
                      style={{ flexGrow: n }}
                      className={cn("h-full", PUNTO[ETAPA[et].tono].replace(/ring-\S+/g, ""))}
                    />
                  ))}
                </span>
              ) : null}
            </button>
          )
        })}
        {filas.map((f) => (
          <FilaSemana
            key={f.titulo}
            {...f}
            dias={dias}
            ents={ents}
            todas={todas}
            faltas={faltas}
            abrir={abrir}
            activo={!!activo}
            sobre={sobre}
          />
        ))}
      </div>
      {/* Los colores de cada etapa están arriba, en la tira, que también filtra. */}
      <p className="text-xs text-muted-foreground">
        Arrastra una entrega a otro día o franja: se abre su cajón con «Pasar a…» ya lleno. Toca el
        día para verlo por repartidor.
      </p>
      {toca.length ? (
        <section
          id="te-toca-semana"
          aria-label="Te toca esta semana"
          className="flex flex-col gap-2 rounded-2xl border border-warning/40 bg-warning-soft/50 p-3"
        >
          <h3 className="px-1 text-sm font-semibold">Te toca esta semana · {toca.length}</h3>
          <ul className="grid grid-cols-[repeat(auto-fill,minmax(22rem,1fr))] gap-2">
            {toca.map((e) => (
              <Tarjeta key={e.id} e={e} abrir={abrir} />
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  )
}

function FilaSemana({
  titulo,
  franja,
  dias,
  ents,
  todas,
  faltas,
  abrir,
  activo,
  sobre,
}: {
  titulo: string
  franja: string | null
  dias: string[]
  ents: Ent[]
  todas: Ent[]
  faltas: Faltas
  abrir: (e: Ent) => void
  activo: boolean
  sobre: Destino | null
}) {
  return (
    <>
      <span className="pt-2 text-xs font-semibold text-muted-foreground">{titulo}</span>
      {dias.map((d) => {
        const lista = ordenar(
          ents.filter((e) => e.fecha === d && (e.p.entrega.franja ?? null) === franja),
        )
        const destino: Destino = { fecha: d, franja }
        const encima = JSON.stringify(destino) === JSON.stringify(sobre)
        const lleno = franja && d >= HOY ? llena(todas, d, franja, faltas) : false
        return (
          <div
            key={d}
            role="gridcell"
            aria-label={`${largo(d)}, ${titulo}: ${lista.length}${lleno ? ", llena" : ""}`}
            data-destino={JSON.stringify(destino)}
            className={cn(
              "flex min-h-24 flex-col gap-1.5 rounded-xl border border-transparent bg-muted/40 p-1.5 transition-colors",
              d === HOY && "bg-primary-soft/40",
              FERIADOS[d] &&
                "bg-[repeating-linear-gradient(135deg,transparent_0_8px,var(--color-muted)_8px_10px)]",
              activo && "border-dashed border-border",
              encima && "border-primary bg-primary-soft",
            )}
          >
            {lleno ? (
              <Badge variant="warning" className="self-start">
                Llena
              </Badge>
            ) : null}
            {lista.map((e) => (
              <Tarjeta key={e.id} e={e} abrir={abrir} compacta />
            ))}
          </div>
        )
      })}
    </>
  )
}

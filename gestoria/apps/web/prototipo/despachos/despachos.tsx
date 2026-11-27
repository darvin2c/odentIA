import {
  Badge,
  Button,
  cn,
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
  PageHeader,
  PageNotice,
  PageShell,
  PersonAvatar,
  useIconSidebarWhileMounted,
  useMediaQuery,
} from "@odentia/ui-patterns"
import { CalendarCheck, Check, MoreHorizontal, Package, Truck } from "lucide-react"
import { type ReactNode, useEffect, useMemo, useState } from "react"
import { AccionDrawer } from "../pedidos/acciones"
import { PedidoDrawer } from "../pedidos/detalle"
import { money, usePedidos } from "../pedidos/modelo"
import { useRuta } from "../ruta"
import {
  ArrastreProvider,
  type Destino,
  Flecha,
  TiraDias,
  useArrastrable,
  useArrastre,
} from "./gestos"
import { ScheduleSnapPager as Pager } from "@odentia/ui-patterns"
import { Cobro, EntregaHoja, FaltaHoja, Foto, listo, NumeroHoja, PasarHoja } from "./hojas"
import {
  CUPO,
  corto,
  type Ent,
  ESTADO,
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
  ordenar,
  plataDe,
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
 * - Arriba, solo lo que necesita a una persona, con su único botón: «Listo: se lo di a Kevin».
 * - Por franja o por repartidor; en escritorio, además, la semana entera.
 */

type Vista = "franja" | "rep"
type Hoja =
  | { k: "entrega"; id: string }
  | {
      k: "pasar"
      id: string
      inicial?: { fecha?: string; franja?: string | null; rep?: string | null }
    }
  | { k: "numero"; id: string }
  | { k: "falta"; rep: string }
  | { k: "pedido"; id: string }
  | { k: "confirmar"; id: string }

const titulo = (fecha: string) =>
  `${largo(fecha).replace(/^./, (c) => c.toUpperCase())}${fecha === HOY ? " · hoy" : fecha === sumar(HOY, 1) ? " · mañana" : ""}`

function resumen(list: Ent[]) {
  const n = list.length
  const toca = list.filter(necesita).length
  const hechas = list.filter((e) => e.estado === "entregado").length
  return [
    n === 0 ? "Sin entregas" : `${n} ${n === 1 ? "entrega" : "entregas"}`,
    hechas ? `${hechas} ${hechas === 1 ? "entregada" : "entregadas"}` : null,
    toca ? `${toca} te ${toca === 1 ? "toca" : "tocan"}` : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

export function DespachosPage() {
  const { rubro, q } = useRuta()
  const all = usePedidos(rubro)
  const ents = useMemo(() => entregasDe(all), [all])
  const [fecha, setFecha] = useState(q.get("dia") ?? HOY)
  const [vista, setVista] = useState<Vista>(q.get("vista") === "rep" ? "rep" : "franja")
  const ancho = useMediaQuery("(min-width: 1024px)")
  const [ver, setVer] = useState<"dia" | "semana">(q.get("ver") === "dia" ? "dia" : "semana")
  const [faltas, setFaltas] = useState<Faltas>(q.get("falta") ? { [HOY]: [q.get("falta")!] } : {})
  const [caja, setCaja] = useState<Record<string, number>>({})
  const [hoja, setHoja] = useState<Hoja | null>(
    q.get("hoja") === "falta" ? { k: "falta", rep: "Jhon" } : null,
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
  const porId = (id: string) => ents.find((e) => e.p.id === id)

  const accion = (e: Ent) => {
    if (!e.boton) return
    if (e.boton.tipo === "listo") listo(rubro, e)
    else if (e.boton.tipo === "confirmar") setHoja({ k: "confirmar", id: e.p.id })
    else if (e.boton.tipo === "numero") setHoja({ k: "numero", id: e.p.id })
    else
      setHoja({
        k: "pasar",
        id: e.p.id,
        inicial: e.boton.tipo === "asignar" ? { fecha: e.fecha } : undefined,
      })
  }
  const abrir = (e: Ent) => setHoja({ k: "entrega", id: e.p.id })
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
      k: "pasar",
      id,
      inicial: {
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
  const comun = { ents, faltas, abrir, accion, setHoja, caja, setCaja }

  const h = hoja && hoja.k !== "falta" ? porId(hoja.id) : undefined
  return (
    <ArrastreProvider
      onSoltar={soltar}
      onSemana={(dir) => setFecha((f) => sumar(f, 7 * dir))}
      describir={describir}
    >
      <PageShell className="flex flex-col gap-4 pb-24 lg:pb-8">
        <PageHeader title="Despachos" />
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
            <Pager
              aria-label="Días: desliza a la izquierda para el día siguiente"
              position={fecha}
              onStep={(dir) => setFecha(sumar(fecha, dir))}
              className="-mx-4 items-start sm:-mx-6"
              paneClassName="px-4 sm:px-6"
              renderPane={(o) => <DiaPane fecha={sumar(fecha, o)} vista={vista} {...comun} />}
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

      {hoja?.k === "entrega" && h ? (
        <EntregaHoja
          e={h}
          onClose={() => setHoja(null)}
          onPasar={() => setHoja({ k: "pasar", id: h.p.id })}
          onAccion={(e) => {
            setHoja(null)
            accion(e)
          }}
          onVerPedido={() => setHoja({ k: "pedido", id: h.p.id })}
        />
      ) : null}
      {hoja?.k === "pasar" && h ? (
        <PasarHoja
          key={JSON.stringify(hoja)}
          e={h}
          inicial={hoja.inicial}
          faltas={faltas}
          onClose={() => setHoja(null)}
        />
      ) : null}
      {hoja?.k === "numero" && h ? <NumeroHoja e={h} onClose={() => setHoja(null)} /> : null}
      {hoja?.k === "confirmar" && h ? (
        <AccionDrawer p={h.p} accion="confirmar" onClose={() => setHoja(null)} />
      ) : null}
      {hoja?.k === "pedido" ? <PedidoDrawer pid={hoja.id} onClose={() => setHoja(null)} /> : null}
      {hoja?.k === "falta" ? (
        <FaltaHoja
          rep={hoja.rep}
          faltas={faltas}
          setFaltas={setFaltas}
          onClose={() => setHoja(null)}
        />
      ) : null}
    </ArrastreProvider>
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

interface Comun {
  ents: Ent[]
  faltas: Faltas
  abrir: (e: Ent) => void
  accion: (e: Ent) => void
  setHoja: (h: Hoja) => void
  caja: Record<string, number>
  setCaja: (c: Record<string, number>) => void
}

/* ---------- El día ---------- */

function DiaPane({
  fecha,
  vista,
  ents,
  faltas,
  abrir,
  accion,
  setHoja,
  caja,
  setCaja,
}: Comun & { fecha: string; vista: Vista }) {
  const dia = ordenar(ents.filter((e) => e.fecha === fecha))
  const toca = dia.filter(necesita)
  const noEntrego = dia.filter((e) => e.estado === "no_entregado")
  const feriado = FERIADOS[fecha]
  const pasado = fecha < HOY
  return (
    <div className="flex flex-col gap-5 lg:grid lg:grid-cols-[minmax(0,400px)_minmax(0,1fr)] lg:items-start lg:gap-6">
      <div className="flex flex-col gap-5 lg:sticky lg:top-40">
        {feriado ? (
          <PageNotice tone="aviso" label="Feriado">
            {largo(fecha).replace(/^./, (c) => c.toUpperCase())}: {feriado}. La tienda no reparte y
            Sofi no ofrece este día.
            {dia.length ? " Lo que se anotó antes, pásalo a otro día." : ""}
          </PageNotice>
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
                <TeToca key={e.p.id} e={e} abrir={abrir} accion={accion} />
              ))}
            </ul>
          </section>
        ) : dia.length && !pasado ? (
          <p className="flex items-center gap-2 rounded-2xl bg-success-soft px-4 py-3 text-sm text-success">
            <Check aria-hidden className="size-4" />
            Nada te toca este día: lo demás avanza solo.
          </p>
        ) : null}
        {vista === "franja" && noEntrego.length ? (
          <Seccion titulo="No se entregó" aviso n={noEntrego.length}>
            {noEntrego.map((e) => (
              <Tarjeta
                key={e.p.id}
                e={e}
                abrir={abrir}
                nota={`${e.p.noEntregado} Vuelve ${fecha === HOY ? "hoy" : "este día"}.`}
              />
            ))}
          </Seccion>
        ) : null}
      </div>
      <div className="flex flex-col gap-5">
        {dia.length === 0 ? (
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
          />
        )}
      </div>
    </div>
  )
}

function TeToca({
  e,
  abrir,
  accion,
}: {
  e: Ent
  abrir: (e: Ent) => void
  accion: (e: Ent) => void
}) {
  const x = e.p.entrega
  const franja = x.franja ? (FRANJA_NOMBRE[x.franja] ?? x.franja) : "Hoy"
  const por =
    e.boton?.tipo === "listo"
      ? `${franja} · empácalo`
      : e.boton?.tipo === "confirmar"
        ? `Mandó un Yape: sin confirmar no sale`
        : e.boton?.tipo === "asignar"
          ? `${franja} · nadie libre`
          : e.boton?.tipo === "numero"
            ? `${x.agencia} a ${x.zona.split(",")[0]} · falta el N.º`
            : `Quedó en un feriado`
  return (
    <li className="flex items-center gap-2 rounded-xl bg-card p-2 shadow-xs">
      <button
        type="button"
        onClick={() => abrir(e)}
        className="flex min-h-11 min-w-0 flex-1 items-center gap-3 rounded-lg text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Foto e={e} className="size-10" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-sm font-semibold">{e.p.clienta}</span>
          <span className="line-clamp-2 text-[13px] leading-snug text-muted-foreground">{por}</span>
        </span>
      </button>
      <Button
        className="h-auto min-h-11 w-[9.25rem] shrink-0 py-1.5 text-center leading-tight whitespace-normal sm:w-auto sm:whitespace-nowrap"
        onClick={() => accion(e)}
      >
        {e.boton?.texto}
      </Button>
    </li>
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

function Tarjeta({
  e,
  abrir,
  orden,
  nota,
  compacta,
}: {
  e: Ent
  abrir: (e: Ent) => void
  orden?: number
  nota?: string
  compacta?: boolean
}) {
  const x = e.p.entrega
  const fantasma = () => (
    <span className="flex items-center gap-2">
      <Foto e={e} className="size-9" />
      <span className="flex min-w-0 flex-col text-sm">
        <b className="truncate">{e.p.clienta}</b>
        <span className="truncate text-xs text-muted-foreground">
          Suéltala en un día, una franja o un repartidor
        </span>
      </span>
    </span>
  )
  const { props, arrastrando, levantando } = useArrastrable(e.p.id, fantasma)
  const quien =
    x.tipo === "agencia"
      ? `${x.agencia}${x.numero ? ` · N.º ${x.numero}` : ""}`
      : [x.franja, x.repartidor ?? "sin repartidor"].filter(Boolean).join(" · ")
  if (compacta)
    return (
      <button
        type="button"
        {...props}
        onClick={() => abrir(e)}
        aria-label={`${e.p.clienta}, ${x.zona}, ${x.repartidor ?? x.agencia ?? "sin repartidor"}, ${e.cobro.texto}, ${ESTADO[e.estado].label}`}
        className={cn(
          "flex min-h-12 w-full touch-manipulation items-center gap-2 rounded-lg border bg-card p-1.5 text-left text-xs outline-none select-none [-webkit-touch-callout:none] hover:border-primary focus-visible:ring-2 focus-visible:ring-ring",
          e.estado === "entregado" && "opacity-60",
          (e.estado === "no_sale" || e.estado === "no_entregado") && "border-destructive/50",
          necesita(e) && "border-warning",
          arrastrando && "opacity-30",
        )}
      >
        <Foto e={e} className="size-8 rounded-md" />
        <span className="flex min-w-0 flex-col">
          <span className="truncate font-semibold">{nombreCorto(e.p.clienta)}</span>
          <span className="truncate text-muted-foreground">
            {(x.repartidor ?? x.agencia ?? "Sin rep.").split(" ")[0]} ·{" "}
            <Cobro e={e} corto className="font-normal" />
          </span>
        </span>
      </button>
    )
  return (
    <li className="list-none">
      <button
        type="button"
        {...props}
        onClick={() => abrir(e)}
        className={cn(
          "flex w-full touch-manipulation items-center gap-3 rounded-xl border bg-card p-2.5 text-left outline-none select-none [-webkit-touch-callout:none] transition-[transform,box-shadow,opacity] duration-200 hover:border-primary focus-visible:ring-2 focus-visible:ring-ring",
          e.estado === "entregado" && "bg-card/60",
          levantando && "motion-safe:scale-[0.98]",
          arrastrando && "opacity-30",
        )}
      >
        {orden ? (
          <span
            aria-label={`Parada ${orden}`}
            className="flex size-7 shrink-0 items-center justify-center rounded-full bg-muted text-xs font-bold tabular-nums"
          >
            {orden}
          </span>
        ) : null}
        <Foto e={e} className={cn(e.estado === "entregado" && "opacity-60")} />
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-baseline gap-1.5">
            <span className="truncate font-semibold">{e.p.clienta}</span>
            <span className="shrink-0 text-xs text-muted-foreground tabular-nums">{e.p.id}</span>
          </span>
          <span className="truncate text-[13px] text-muted-foreground">
            {x.zona.split(",")[0]} · {quien}
          </span>
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]">
            <Cobro e={e} />
            <Badge variant={ESTADO[e.estado].tono}>{ESTADO[e.estado].label}</Badge>
          </span>
          {nota ? <span className="text-[13px] text-destructive">{nota}</span> : null}
        </span>
      </button>
    </li>
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
                    <Tarjeta key={e.p.id} e={e} abrir={abrir} />
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
}: {
  fecha: string
  dia: Ent[]
  ents: Ent[]
  faltas: Faltas
  abrir: (e: Ent) => void
  setHoja: (h: Hoja) => void
  caja: Record<string, number>
  setCaja: (c: Record<string, number>) => void
}) {
  const hoy = fecha === HOY
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
    <div className="flex flex-col gap-5 xl:grid xl:grid-cols-2 xl:items-start">
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
                  <div className="flex justify-between gap-3">
                    <span className="text-muted-foreground">Ya cobró en efectivo</span>
                    <b className="tabular-nums">{money(plata.cobrado)}</b>
                  </div>
                  {recibido !== undefined ? (
                    <p className="flex items-center gap-2 text-success">
                      <Check aria-hidden className="size-4" />
                      Caja recibió {money(recibido)} de {g.rep}.
                    </p>
                  ) : (
                    <Button
                      variant={pendientes ? "outline" : "default"}
                      className="h-11"
                      disabled={plata.cobrado === 0}
                      onClick={() => {
                        setCaja({ ...caja, [g.rep!]: plata.cobrado })
                        toast.success(`Quedó en Caja: ${money(plata.cobrado)} de ${g.rep}.`, {
                          description: pendientes
                            ? `Le quedan ${pendientes} por entregar; lo que cobre después se suma aparte.`
                            : "Cerró su día.",
                        })
                      }}
                    >
                      Recibí {money(plata.cobrado)} de {g.rep}
                    </Button>
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
                  <Tarjeta
                    key={e.p.id}
                    e={e}
                    abrir={abrir}
                    orden={g.rep ? i + 1 : undefined}
                    nota={e.estado === "no_entregado" ? `${e.p.noEntregado}` : undefined}
                  />
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
    </div>
  )
}

/* ---------- La semana entera (escritorio) ---------- */

function SemanaTablero({
  lunes,
  fecha,
  ents,
  faltas,
  abrir,
  accion,
  abrirDia,
}: Comun & { lunes: string; fecha: string; abrirDia: (f: string) => void }) {
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
        <section
          aria-label="Te toca esta semana"
          className="flex flex-col gap-2 rounded-2xl border border-warning/40 bg-warning-soft/50 p-3"
        >
          <h3 className="px-1 text-sm font-semibold">Te toca esta semana · {toca.length}</h3>
          <ul className="grid grid-cols-2 gap-2 2xl:grid-cols-3">
            {toca.map((e) => (
              <TeToca key={e.p.id} e={e} abrir={abrir} accion={accion} />
            ))}
          </ul>
        </section>
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
                {l.some((e) => e.estado === "no_entregado") ? " · 1 vuelve" : ""}
              </span>
            </button>
          )
        })}
        {filas.map((f) => (
          <FilaSemana
            key={f.titulo}
            {...f}
            dias={dias}
            ents={ents}
            faltas={faltas}
            abrir={abrir}
            activo={!!activo}
            sobre={sobre}
          />
        ))}
      </div>
      <p className="text-xs text-muted-foreground">
        Arrastra una entrega a otro día o franja, o ábrela y usa «Pasar a…». Toca el día para verlo
        por repartidor.
      </p>
    </div>
  )
}

function FilaSemana({
  titulo,
  franja,
  dias,
  ents,
  faltas,
  abrir,
  activo,
  sobre,
}: {
  titulo: string
  franja: string | null
  dias: string[]
  ents: Ent[]
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
        const lleno = franja && d >= HOY ? llena(ents, d, franja, faltas) : false
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
              <Tarjeta key={e.p.id} e={e} abrir={abrir} compacta />
            ))}
          </div>
        )
      })}
    </>
  )
}

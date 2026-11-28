import {
  Badge,
  Button,
  cn,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Input,
  toast,
  useIsMobile,
} from "@odentia/ui"
import { DetailDrawer, RadioChips } from "@odentia/ui-patterns"
import {
  Banknote,
  Bike,
  Camera,
  Check,
  CircleAlert,
  MoreHorizontal,
  PackageOpen,
  Repeat,
  Undo2,
  UserRound,
} from "lucide-react"
import { type ReactNode, useEffect, useId, useRef, useState, useSyncExternalStore } from "react"
import { foto, RUBROS } from "../datos"
import { elegirSolo, mostrarCobro, PasarHoja, pasar, SofiAvisa, textoAviso } from "../despachos/hojas"
import {
  CUPO,
  corto,
  type Ent,
  ETAPA,
  entregaDe,
  entregasDe,
  type Faltas,
  FERIADOS,
  FRANJA_NOMBRE,
  FRANJAS,
  HOY,
  largo,
  ocupadas,
  REPARTIDORES,
  sumar,
} from "../despachos/semana"
import { ir, useRuta } from "../ruta"
import { AccionDrawer, empacar } from "./acciones"
import { pagoAntes, useCobro, vueltoDe } from "./cobros"
import { acciones, Bloque, Carrito, EntregaB, OrigenB, Pasos, queSigue, Saldo } from "./detalle"
import { Ampliable, FotoMarcada, ImagenPago } from "./ejemplos"
import { Botones, CajonProvider } from "./hoja"
import {
  type Accion,
  avisar,
  CANAL,
  cuentas,
  money,
  mover,
  nuevoId,
  PASO,
  type Pedido,
  pedidosDe,
  tocaDe,
  usePedidos,
} from "./modelo"
import { aprobar, devolver, vueltaToca } from "./vuelta"
import { ExcepcionDrawer, RevisarDrawer, VueltaBloque } from "./vuelta-ui"

/**
 * El cajón «pedido + lo que toca», uno solo para toda la app: Despachos, «Te toca» de Inicio y de
 * Pedidos, la lista, la página del pedido y su menú ⋯. Ningún botón actúa en un toque: todo lo
 * que cambia algo se confirma aquí, con el pedido a la vista.
 *
 * - En escritorio, dos columnas: a la izquierda el pedido (los pasos, el carrito, el saldo y la
 *   entrega); a la derecha lo que toca, con su imagen grande (la captura, el voucher, la foto de
 *   la falla o del recojo, lo que va en el paquete) y sus botones ahí mismo.
 * - En el celular, primero la acción con su imagen, después el pedido, y los botones fijos abajo.
 * - Es la misma forma para todas las acciones, traigan imagen o no.
 *
 * El ancho de dos columnas no existe en `DetailDrawer` (llega a `xl`, 40rem): aquí se pasa por
 * `className`. En la app va como un tamaño nuevo de la pieza común, en su propio PR de shared.
 */
const ANCHO = "data-[swipe-axis=x]:sm:[--drawer-content-width:min(68rem,calc(100vw-2rem))]"

export interface Destino {
  fecha?: string
  franja?: string | null
  rep?: string | null
}

/** Lo que puede tocar: las acciones del pedido y las de Despachos. */
type A = Accion | "deshacer" | "numero" | "pasar_d" | "pasar_hoja"

/* ---------- Abrir el cajón desde cualquier parte ---------- */

interface Abierto {
  pid: string
  accion?: Accion | "deshacer"
  pago?: string
  /** Al cerrar: volver a donde estaba (por ejemplo, a la lista de «Te toca»). */
  alCerrar?: () => void
}
let abierto: Abierto | null = null
const subs = new Set<() => void>()
const avisarSubs = () => {
  for (const f of subs) f()
}

/** Abre el cajón del pedido, con lo que toca o con la acción pedida (del ⋯ o del saldo). */
export function abrirCajon(pid: string, accion?: Accion | "deshacer", o: Omit<Abierto, "pid" | "accion"> = {}) {
  abierto = { pid, accion, ...o }
  avisarSubs()
}
function cerrarCajon() {
  const a = abierto
  abierto = null
  avisarSubs()
  a?.alCerrar?.()
}

/** El cajón de toda la app. Despachos monta el suyo, con su semana y sus faltas. */
export function CajonGlobal() {
  const a = useSyncExternalStore(
    (f) => {
      subs.add(f)
      return () => subs.delete(f)
    },
    () => abierto,
  )
  const { rubro, path } = useRuta()
  const all = usePedidos(rubro)
  // Ir a otra pantalla (por ejemplo, «Ver la página del pedido») cierra el cajón.
  const antes = useRef(path)
  useEffect(() => {
    if (antes.current === path) return
    antes.current = path
    if (abierto) {
      abierto = null
      avisarSubs()
    }
  }, [path])
  const p = a ? all.find((x) => x.id === a.pid) : undefined
  if (!a || !p) return null
  return (
    <AccionCajon
      key={`${a.pid}-${a.accion ?? ""}-${a.pago ?? ""}`}
      p={p}
      accion={a.accion}
      pago={a.pago}
      onClose={cerrarCajon}
    />
  )
}

/* ---------- El cajón ---------- */

/** El número de cada repartidor (de ejemplo), para llamarlo desde el cajón. */
const TEL: Record<string, string> = { Kevin: "987 120 455", Jhon: "986 340 712" }

/** El día siguiente que la tienda reparte (sin feriado ni domingo). */
function siguienteDia(desde: string) {
  let f = sumar(desde < HOY ? HOY : desde, 1)
  while (FERIADOS[f] || new Date(`${f}T12:00:00Z`).getUTCDay() === 0) f = sumar(f, 1)
  return f
}

export function AccionCajon({
  p,
  accion,
  pago,
  e: ent,
  pasarA,
  faltas = {},
  onFalta,
  dock = false,
  onClose,
}: {
  p: Pedido
  /** La acción pedida (del ⋯, del saldo o de un botón). Si no, lo que toca. */
  accion?: Accion | "deshacer"
  pago?: string
  /** Desde Despachos: la entrega, con su día. */
  e?: Ent
  /** Al soltar una entrega: lo que toca es «Pasar a…», ya lleno. */
  pasarA?: Destino
  faltas?: Faltas
  onFalta?: (rep: string) => void
  /** En «El día» de Despachos va en la columna lateral; en lo demás, encima. */
  dock?: boolean
  onClose: () => void
}) {
  const { rubro } = useRuta()
  const isMobile = useIsMobile()
  const real = pedidosDe(rubro).find((x) => x.id === p.id) ?? p
  const e = ent ?? entregaDe(p) ?? undefined
  const r = e?.recojo
  const x = p.entrega
  const k = cuentas(p)
  const salio = ["en_camino", "entregado"].includes(p.paso)
  const feriado = !!e && !!FERIADOS[e.fecha] && !salio
  const pasarInicial: Destino | undefined =
    pasarA ?? (feriado && e ? { fecha: siguienteDia(e.fecha), franja: x.franja, rep: undefined } : undefined)
  const t = tocaDe(real)
  const deBoton: Record<string, A | undefined> = {
    listo: "empacar",
    confirmar: "confirmar",
    asignar: "asignar",
    numero: "numero",
    pasar: "pasar_d",
    vuelta: vueltaToca(real)?.accion,
  }
  const pedida: A | undefined = pasarInicial
    ? "pasar_d"
    : (accion ?? (ent?.boton ? deBoton[ent.boton.tipo] : t?.accion))
  // Un pedido por agencia no tiene repartidor que elegir: lo que toca es anotar su número de envío.
  const principal: A | undefined =
    pedida === "asignar" && x.tipo === "agencia" && !x.numero ? "numero" : pedida
  const [a, setA] = useState<A | undefined>(principal)
  const [pagoId, setPagoId] = useState(pago)
  const [pasarIni, setPasarIni] = useState<Destino>({})
  const [botones, setBotones] = useState<HTMLElement | null>(null)
  const volver = a !== principal ? () => setA(principal) : undefined
  const ir_ = (b: A) => setA(b)

  const texto = pasarA
    ? "Pasar esta entrega a donde la soltaste."
    : ent
      ? ent.toca.texto
      : t
        ? t.texto
        : e
          ? e.toca.texto
          : queSigue(real).texto
  const persona = !!principal

  // Las correcciones a mano: las del pedido y, en Despachos, las del día.
  const otras = acciones(real).otras
  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="ghost" size="icon" className="size-11 shrink-0" aria-label="Más: corregir este pedido" />
        }
      >
        <MoreHorizontal aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {r && !salio && p.paso !== "entregado" ? (
          <DropdownMenuItem className="min-h-11" onClick={() => (setPasarIni({}), ir_("pasar_hoja"))}>
            Pasar el recojo a…
          </DropdownMenuItem>
        ) : null}
        {(r ? [] : otras).map(([b, l]) => (
          <DropdownMenuItem
            key={b}
            className="min-h-11"
            onClick={() => {
              if (e && b === "pasar") {
                setPasarIni({})
                ir_("pasar_hoja")
              } else ir_(b)
            }}
          >
            {l}
          </DropdownMenuItem>
        ))}
        {x.repartidor && e?.fecha === HOY && onFalta && !salio ? (
          <DropdownMenuItem className="min-h-11" onClick={() => onFalta(x.repartidor!)}>
            {x.repartidor} no viene hoy
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem className="min-h-11" onClick={() => ir(`/pedidos/${p.id}`)}>
          Ver la página del pedido
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  // Lo que toca, con su imagen grande y su formulario.
  let panel: ReactNode = null
  if (a === "empacar") panel = <Empacar p={p} e={e} onHecho={onClose} />
  else if (a === "asignar" && e) panel = <Asignar e={e} faltas={faltas} onOtroDia={() => ir_("pasar_hoja")} onHecho={onClose} />
  else if (a === "numero" && e) panel = <Numero e={e} onHecho={onClose} />
  else if (a === "pasar_d" && e && pasarInicial)
    panel = (
      <PasarPie
        key={JSON.stringify(pasarInicial)}
        e={e}
        inicial={pasarInicial}
        faltas={faltas}
        onCambiar={(d) => {
          setPasarIni(d)
          ir_("pasar_hoja")
        }}
        onHecho={onClose}
      />
    )
  else if (a === "pasar_hoja" && e)
    panel = <PasarHoja key={JSON.stringify(pasarIni)} e={e} inicial={pasarIni} faltas={faltas} onClose={onClose} />
  else if (a === "aprobar_vuelta") panel = <AprobarVuelta p={real} onHecho={onClose} />
  else if (a === "devolver") panel = <Devolver p={real} onHecho={onClose} />
  else if (a === "revisar")
    panel = (
      <>
        <ImagenVuelta p={real} recojo />
        <RevisarDrawer p={real} onClose={onClose} />
      </>
    )
  else if (a === "excepcion")
    panel = (
      <>
        <ImagenVuelta p={real} />
        <ExcepcionDrawer p={real} onClose={onClose} />
      </>
    )
  else if (a === "deshacer") {
    const g = real.pagos.find((y) => y.id === pagoId)
    panel = (
      <>
        {g && (g.captura || g.medio === "pos") ? (
          <Ampliable titulo={g.medio === "pos" ? "Voucher del POS" : "La captura"} className="mx-auto max-w-64">
            <ImagenPago p={real} g={g} tienda={RUBROS[rubro].store.name} />
          </Ampliable>
        ) : null}
        <AccionDrawer p={real} accion="deshacer" pagoId={pagoId} onClose={onClose} />
      </>
    )
  } else if (a && a !== "numero" && a !== "pasar_d" && a !== "pasar_hoja")
    panel = <AccionDrawer p={real} accion={a} onClose={onClose} />

  const accionB = (
    <section
      aria-label="Lo que toca"
      data-lo-que-toca
      className="flex min-w-0 flex-col gap-4 max-sm:[&_input:not([type=checkbox])]:min-h-11 max-sm:[&_label]:min-h-11 pointer-coarse:[&_input:not([type=checkbox])]:min-h-11 @3xl:sticky @3xl:top-0 @3xl:order-2 @3xl:rounded-xl @3xl:border @3xl:bg-card @3xl:p-4"
    >
      <div className="flex items-start gap-2">
        <p
          className={cn(
            "flex min-w-0 flex-1 items-start gap-2 rounded-xl px-3 py-2.5 text-sm",
            persona ? "bg-warning-soft" : "bg-muted/70",
          )}
        >
          {persona ? (
            <UserRound className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          ) : (
            <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          )}
          <span>
            {persona ? <b>Te toca: </b> : <b>Sigue solo: </b>}
            {texto.replace(/^Sigue solo: /, "")}
            {!persona ? (
              <span className="block text-xs text-muted-foreground">Si hay que corregir algo, está en ⋯.</span>
            ) : null}
          </span>
        </p>
        {menu}
      </div>
      <CajonProvider value={{ botones, volver }}>{panel}</CajonProvider>
      {!persona && a === undefined && r ? <RecojoCorto e={e!} /> : null}
      {(a === undefined || a === "empacar") && !r ? <PuertaB p={real} /> : null}
      {/* En escritorio, los botones van aquí, bajo la acción; en el celular, fijos al pie. */}
      {isMobile ? null : <div ref={setBotones} className="empty:hidden" />}
    </section>
  )

  const cuando = e ? `${e.fecha === HOY ? "hoy" : largo(e.fecha)}${x.franja ? ` · ${x.franja}` : ""}` : null
  const etapa = e ? ETAPA[e.etapa] : PASO[p.paso]
  const ev = p.eventos.filter((v) => v.paso || r).slice(-3)
  const pedidoB = (
    // Las secciones de Pedidos traen botones de 32 px: en el celular, 44 (va en el PR de shared).
    <div className="flex min-w-0 flex-col gap-5 @3xl:order-1 max-sm:[&_button]:min-h-11 pointer-coarse:[&_button]:min-h-11">
      <section aria-label="La etapa" className="elevated flex flex-col gap-3 rounded-xl border bg-card p-4">
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant={etapa.tono}>{etapa.label}</Badge>
          {e ? (
            <span
              hidden={!mostrarCobro(e)}
              className={cn(
                "text-sm font-medium",
                e.cobro.tono === "ok" ? "text-success" : e.cobro.tono === "falta" ? "text-warning" : "text-destructive",
              )}
            >
              {e.cobro.texto}
            </span>
          ) : k.pagado ? (
            <span className="text-sm font-medium text-success">Pagado</span>
          ) : k.falta && p.paso !== "anulado" ? (
            <span className="text-sm font-medium text-warning">Falta {money(k.falta)}</span>
          ) : null}
          {r ? null : <span className="ml-auto text-sm font-semibold tabular-nums">{money(k.total)}</span>}
        </div>
        {r ? <PasosRecojo p={p} /> : <Pasos p={p} />}
        {ev.length ? (
          <ol className="flex flex-col gap-1 text-xs text-muted-foreground">
            {ev.map((v) => (
              <li key={v.id}>
                <b className="font-medium text-foreground">{r ? v.texto : v.paso ? PASO[v.paso].corto : ""}</b> ·{" "}
                {v.quien} · {v.cuando}
              </li>
            ))}
          </ol>
        ) : null}
      </section>
      {r ? <RecojoB e={e!} /> : null}
      {real.vuelta ? <VueltaBloque p={real} /> : null}
      {r?.tipo === "devolucion" || (r && !r.lleva) ? null : <Carrito p={p} />}
      {r || p.paso === "anulado" ? null : (
        <Saldo
          p={p}
          onAccion={(b, g) => {
            setPagoId(g)
            ir_(b)
          }}
        />
      )}
      <EntregaB p={p} />
      {x.repartidor ? (
        <p className="-mt-3 flex items-center gap-2 px-1 text-sm text-muted-foreground">
          <Bike className="size-4" aria-hidden />
          {x.repartidor} · {TEL[x.repartidor] ?? "sin número"} · usa gestorIA Reparto
        </p>
      ) : null}
      <Bloque title="La clienta">
        <div className="flex flex-col gap-0.5 rounded-xl border p-3 text-sm">
          <span className="font-medium">{p.clienta}</span>
          <span className="text-muted-foreground">
            {p.telefono} · le escribe por {CANAL[p.canal]}
          </span>
        </div>
      </Bloque>
      <OrigenB p={p} />
      <Button variant="outline" className="h-11 self-start" onClick={() => ir(`/pedidos/${r ? r.de : p.id}`)}>
        Ver la página del pedido
      </Button>
    </div>
  )

  return (
    <DetailDrawer
      open
      dock={dock}
      size="xl"
      className={ANCHO}
      onClose={onClose}
      title={`${p.clienta} · ${p.id}`}
      description={
        real.vuelta && !ent
          ? `${real.vuelta.tipo === "cambio" ? "Cambio" : "Devolución"} de un pedido entregado · ${money(k.total)}`
          : e
          ? `${r ? (r.tipo === "cambio" ? "Recojo del cambio" : "Recojo de la devolución") : x.zona} · ${cuando}${x.repartidor ? ` · ${x.repartidor}` : x.agencia ? ` · ${x.agencia}` : ""}`
          : `${PASO[p.paso].label} · ${money(k.total)}`
      }
      footer={isMobile && a ? <div ref={setBotones} className="w-full" data-botones /> : undefined}
    >
      <div className="@container">
        <div className="grid min-w-0 gap-5 @3xl:grid-cols-[minmax(0,1fr)_minmax(0,27rem)] @3xl:items-start">
          {accionB}
          {pedidoB}
        </div>
      </div>
    </DetailDrawer>
  )
}

/* ---------- El pago contra entrega ---------- */

/**
 * En la puerta: lo que cobra el repartidor, con cuánto paga la clienta y el vuelto que lleva; si
 * pagó antes con su link; o, si no lo recibió, qué pasa con el producto y con el viaje.
 */
function PuertaB({ p }: { p: Pedido }) {
  const { rubro } = useRuta()
  const pol = useCobro(rubro)
  const k = cuentas(p)
  const n = p.clienta.split(" ")[0]
  const rep = p.entrega.repartidor ?? "El repartidor"
  if (p.rechazo) {
    const cargo = k.cargos
    return (
      <div className="flex flex-col gap-2 rounded-xl border border-destructive/40 p-3 text-sm">
        <b className="flex items-center gap-2">
          <Undo2 className="size-4 text-destructive" aria-hidden />
          No se entregó: {p.rechazo.motivo.toLowerCase()}
        </b>
        {p.rechazo.dijo ? <span className="text-muted-foreground">{n} dijo: «{p.rechazo.dijo}»</span> : null}
        <dl className="flex flex-col divide-y rounded-lg border">
          <div className="flex justify-between gap-3 px-3 py-2">
            <dt className="text-muted-foreground">El producto</dt>
            <dd className="text-right font-medium">
              {p.rechazo.enTienda ? "Ya está en la tienda" : `Vuelve a la tienda con ${p.rechazo.quien}`}
            </dd>
          </div>
          <div className="flex justify-between gap-3 px-3 py-2">
            <dt className="text-muted-foreground">El viaje</dt>
            <dd className="text-right font-medium">
              {cargo ? `${money(cargo)} a su saldo (cargo propuesto)` : "Lo paga la tienda"}
            </dd>
          </div>
          <div className="flex justify-between gap-3 px-3 py-2">
            <dt className="text-muted-foreground">Sofi</dt>
            <dd className="text-right font-medium">Le preguntó si lo quiere otro día</dd>
          </div>
        </dl>
        <span className="text-xs text-muted-foreground">
          Según tu política de cobros: el viaje que no se entregó lo paga {pol.viaje === "clienta" ? "la clienta" : "la tienda"}.
        </span>
      </div>
    )
  }
  if (p.paso === "anulado" || p.paso === "entregado") return null
  if (p.reglaCobro) {
    const dijo = [...p.chat].reverse().find((m) => m.de === "sofi")?.texto
    return (
      <div className="flex flex-col gap-2 rounded-xl border p-3 text-sm">
        <b className="flex items-center gap-2">
          <Banknote className="size-4 text-primary" aria-hidden />
          Pidió pagar al recibir
        </b>
        <span>
          <b>La regla de la tienda:</b> {p.reglaCobro}
        </span>
        {dijo ? <span className="rounded-lg bg-muted px-2.5 py-1.5">Sofi: «{dijo}»</span> : null}
        <span className="text-xs text-muted-foreground">
          Sale cuando pague su link. Las zonas que aceptan pago al recibir están en Configuración › Cobros.
        </span>
      </div>
    )
  }
  if (pagoAntes(p))
    return (
      <p className="flex items-start gap-2 rounded-xl bg-success-soft px-3 py-2.5 text-sm">
        <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
        <span>
          <b>Era al recibir y pagó antes con su link.</b> Sofi le recordó el monto esta mañana y le ofreció pagar ya;
          {` ${rep}`} ya no cobra en la puerta.
        </span>
      </p>
    )
  if (!k.alRecibir || !k.falta) return null
  const vuelto = vueltoDe(p)
  const hoy = p.entrega.dia === "Hoy"
  return (
    <div className="flex flex-col gap-2 rounded-xl border p-3 text-sm">
      <b className="flex items-center gap-2">
        <Banknote className="size-4 text-primary" aria-hidden />
        En la puerta
      </b>
      <dl className="flex flex-col divide-y rounded-lg border">
        <div className="flex justify-between gap-3 px-3 py-2">
          <dt className="text-muted-foreground">{rep} cobra</dt>
          <dd className="font-heading text-lg font-bold tabular-nums">{money(k.falta)}</dd>
        </div>
        {p.pagaCon ? (
          <div className="flex justify-between gap-3 px-3 py-2">
            <dt className="text-muted-foreground">{n} paga con</dt>
            <dd className="font-medium tabular-nums">{money(p.pagaCon)} en efectivo</dd>
          </div>
        ) : null}
        {vuelto ? (
          <div className="flex justify-between gap-3 bg-warning-soft px-3 py-2">
            <dt className="font-medium">Lleva vuelto de</dt>
            <dd className="font-heading text-lg font-bold tabular-nums">{money(vuelto)}</dd>
          </div>
        ) : null}
      </dl>
      <span className="text-xs text-muted-foreground">
        {p.pagaCon ? "Sofi le preguntó con cuánto paga al cerrar el pedido. " : ""}
        {hoy
          ? "Hoy a las 8 a. m. Sofi le recordó el monto y le ofreció pagar ya con su link, para no esperar el vuelto."
          : "El día de la entrega, Sofi le recuerda el monto y le ofrece pagar ya con su link."}
      </span>
      <Button
        variant="outline"
        className="propuesta h-11 self-start"
        onClick={() => {
          mover(
            rubro,
            p.id,
            (x) => {
              x.pagos.push({
                id: nuevoId("pg"),
                medio: "link",
                monto: cuentas(x).falta,
                estado: "confirmado",
                cuando: "Hoy · ahora",
                quien: "la pasarela",
              })
            },
            { actor: "pasarela", quien: "La pasarela", texto: "Pagó antes con su link. Ya no es al recibir." },
          )
          toast.success(`${n} pagó con su link: ${rep} ya no cobra en la puerta.`)
        }}
      >
        Prototipo: {n} paga ya con su link
      </Button>
    </div>
  )
}

/* ---------- Lo que toca ---------- */

function Titulo({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="flex flex-col gap-0.5">
      <h3 className="font-heading text-base font-semibold">{children}</h3>
      {sub ? <p className="text-sm text-muted-foreground">{sub}</p> : null}
    </div>
  )
}

/** Empacar: lo que va en el paquete, con la foto de cada producto. Se confirma aquí. */
function Empacar({ p, e, onHecho }: { p: Pedido; e?: Ent; onHecho: () => void }) {
  const { rubro } = useRuta()
  const x = p.entrega
  const va = p.lineas.filter((l) => !l.vuelve)
  const agencia = x.tipo === "agencia"
  const k = cuentas(p)
  const unidades = va.reduce((s, l) => s + l.qty, 0)
  return (
    <div className="flex flex-col gap-4">
      <Titulo sub={`${unidades} ${unidades === 1 ? "producto" : "productos"}. Míralos antes de cerrar la caja.`}>
        Va en el paquete
      </Titulo>
      <ul className={cn("grid gap-3", va.length > 1 ? "grid-cols-2" : "grid-cols-1")}>
        {va.map((l) => (
          <li key={l.id} className="flex flex-col gap-1.5">
            <Ampliable titulo={`${l.nombre} · ${l.variante}`}>
              <img
                src={foto(l.foto)}
                alt={`${l.nombre} · ${l.variante}`}
                className={cn("w-full rounded-xl bg-muted object-cover", va.length > 1 ? "aspect-square" : "aspect-[4/3]")}
              />
            </Ampliable>
            <span className="text-sm">
              <b className="block font-medium">{l.nombre}</b>
              <span className="text-muted-foreground">
                {l.variante} · × {l.qty}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {e?.recojo?.lleva ? (
        <p className="flex items-start gap-2 text-sm">
          <Repeat className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <span>
            <b>Y recoge:</b> {e.recojo.recoge}.
          </span>
        </p>
      ) : null}
      {k.falta && p.cobro === "al_recibir" ? (
        <p className="text-sm text-muted-foreground">
          {x.repartidor} cobra {money(k.falta)} en la puerta.
        </p>
      ) : null}
      <Botones>
        <Button
          onClick={() => {
            empacar(rubro, p)
            onHecho()
          }}
        >
          {agencia ? `Listo: lo dejé en ${x.agencia ?? "la agencia"}` : `Listo: se lo di a ${x.repartidor ?? "el repartidor"}`}
        </Button>
      </Botones>
    </div>
  )
}

/** La foto que importa en un cambio o una devolución: la falla, el recojo o lo que vuelve y sale. */
function ImagenVuelta({ p, recojo }: { p: Pedido; recojo?: boolean }) {
  const v = p.vuelta
  if (!v) return null
  const l = v.vuelven[0]
  if (!l) return null
  const n = p.clienta.split(" ")[0]
  if (recojo || v.foto)
    return (
      <div className={cn("grid gap-3", recojo && v.foto ? "grid-cols-2" : "grid-cols-1")}>
        {v.foto ? (
          <Ampliable titulo="La foto de la falla">
            <FotoMarcada src={l.foto} tipo="falla" pie={`La falla, en la foto de ${n}`} />
          </Ampliable>
        ) : null}
        {recojo ? (
          <Ampliable titulo="La foto al recoger">
            <FotoMarcada
              src={l.foto}
              tipo="recojo"
              pie={`Al recoger · ${v.hechos.vuelve?.quien ?? v.repartidor ?? "Kevin"} · ${v.hechos.vuelve?.cuando ?? "hoy"}`}
            />
          </Ampliable>
        ) : null}
      </div>
    )
  return (
    <div className={cn("grid gap-3", v.sale ? "grid-cols-2" : "grid-cols-1")}>
      <figure className="flex flex-col gap-1.5">
        <Ampliable titulo={`Vuelve: ${l.nombre} · ${l.variante}`}>
          <img src={foto(l.foto)} alt="" className="aspect-square w-full rounded-xl bg-muted object-cover" />
        </Ampliable>
        <figcaption className="text-sm">
          <span className="text-xs text-muted-foreground">Vuelve</span>
          <b className="block font-medium">{l.variante}</b>
        </figcaption>
      </figure>
      {v.sale ? (
        <figure className="flex flex-col gap-1.5">
          <Ampliable titulo={`Sale: ${v.sale.nombre} · ${v.sale.variante}`}>
            <img src={foto(v.sale.foto)} alt="" className="aspect-square w-full rounded-xl bg-muted object-cover" />
          </Ampliable>
          <figcaption className="text-sm">
            <span className="text-xs text-muted-foreground">Sale</span>
            <b className="block font-medium">
              {v.sale.nombre === l.nombre ? v.sale.variante : `${v.sale.nombre} · ${v.sale.variante}`}
            </b>
          </figcaption>
        </figure>
      ) : null}
    </div>
  )
}

/** Aprobar el caso que dejó listo Sofi, con lo de la política a la izquierda. */
function AprobarVuelta({ p, onHecho }: { p: Pedido; onHecho: () => void }) {
  const { rubro } = useRuta()
  const v = p.vuelta
  if (!v) return null
  const n = p.clienta.split(" ")[0]
  const t = v.tipo === "cambio" ? "el cambio" : "la devolución"
  return (
    <div className="flex flex-col gap-4">
      <Titulo sub="Sofi lo dejó listo según tu política. Lo de la política está en el pedido.">
        Aprobar {t}
      </Titulo>
      <ImagenVuelta p={p} />
      <p className="rounded-xl bg-muted px-3 py-2 text-sm">
        <span className="block text-xs text-muted-foreground">Al aprobar, Sofi le dice a {n}:</span>«{v.arm.sofi}»
      </p>
      <Botones>
        <Button
          onClick={() => {
            aprobar(rubro, p, "Rosa")
            toast.success(`Aprobado. Sofi ya le avisó a ${n} y sigue solo.`)
            onHecho()
          }}
        >
          Aprobar {t}
        </Button>
      </Botones>
    </div>
  )
}

/** Devolver el dinero: la pasarela sola, o una persona desde su app («Ya lo devolví»). */
function Devolver({ p, onHecho }: { p: Pedido; onHecho: () => void }) {
  const { rubro } = useRuta()
  const t = vueltaToca(p)
  const v = p.vuelta
  if (!t || !v) return null
  const n = p.clienta.split(" ")[0]
  return (
    <div className="flex flex-col gap-4">
      <Titulo sub={`Lo que volvió ya se revisó. ${v.arm.monto ? `Son ${money(v.arm.monto)}.` : ""}`}>{t.boton}</Titulo>
      <ImagenVuelta p={p} recojo />
      <p className="rounded-xl border p-3 text-sm">{t.texto}</p>
      <Botones>
        <Button
          onClick={() => {
            devolver(rubro, p, "Rosa")
            toast.success(`Devuelto. Sofi le avisó a ${n}.`)
            onHecho()
          }}
        >
          {t.boton}
        </Button>
      </Botones>
    </div>
  )
}

/* ---------- Lo de Despachos: quién lo lleva, el N.º, pasar a otro día ---------- */

function Asignar({
  e,
  faltas,
  onOtroDia,
  onHecho,
}: {
  e: Ent
  faltas: Faltas
  onOtroDia: () => void
  onHecho: () => void
}) {
  const { rubro } = useRuta()
  const todas = entregasDe(pedidosDe(rubro)).filter((y) => y.p.id !== e.p.id)
  const franja = e.p.entrega.franja
  const salen = REPARTIDORES.filter((r) => !(faltas[e.fecha] ?? []).includes(r))
  const lleva = (r: string) => ocupadas(todas, e.fecha, franja, r)
  // Viene elegido el más libre.
  const [rep, setRep] = useState<string>([...salen].sort((a, b) => lleva(a) - lleva(b))[0] ?? "Kevin")
  const id = useId()
  return (
    <div className="flex flex-col gap-3">
      <Titulo sub="Nadie de siempre está libre en esa franja.">Elegir cómo sale</Titulo>
      <span id={id} className="text-xs font-semibold text-muted-foreground">
        Quién lo lleva {franja ? FRANJA_NOMBRE[franja]?.toLowerCase() : "hoy"}
      </span>
      <RadioChips
        className="[&_label]:min-h-11"
        aria-labelledby={id}
        value={rep}
        options={salen.map((r) => ({ value: r, label: `${r} · lleva ${lleva(r)} de ${CUPO}` }))}
        onChange={(v) => setRep(v ?? rep)}
      />
      {lleva(rep) >= CUPO ? (
        <p className="text-sm text-warning">
          {rep} ya tiene su máximo: llevaría {CUPO + 1}. Puedes hacerlo igual.
        </p>
      ) : null}
      <Botones>
        <Button variant="outline" onClick={onOtroDia}>
          Otro día…
        </Button>
        <Button
          className="basis-40 grow-[2]"
          onClick={() => {
            pasar(rubro, e.p, e.fecha, franja, rep, false)
            toast.success(`Lo lleva ${rep}.`, { description: "Le llega el aviso a su app." })
            onHecho()
          }}
        >
          Que lo lleve {rep}
        </Button>
      </Botones>
    </div>
  )
}

function Numero({ e, onHecho }: { e: Ent; onHecho: () => void }) {
  const { rubro } = useRuta()
  const [num, setNum] = useState("")
  const [sofi, setSofi] = useState(true)
  const [err, setErr] = useState(false)
  const n = e.p.clienta.split(" ")[0]
  const ag = e.p.entrega.agencia ?? "la agencia"
  const texto = `${n}, tu pedido ${e.p.id} va por ${ag}, número de envío ${num || "(el que anotes)"}. Lo recoges en su agencia de ${e.p.entrega.zona.split(",")[0]}.`
  const id = useId()
  const fid = useId()
  return (
    <form
      id={fid}
      className="flex flex-col gap-3"
      onSubmit={(ev) => {
        ev.preventDefault()
        if (!num.trim()) return setErr(true)
        mover(
          rubro,
          e.p.id,
          (x) => {
            x.entrega.numero = num.trim()
            x.paso = "en_camino"
            x.toca = undefined
            if (sofi) avisar(x, "salio", texto)
          },
          { actor: "persona", quien: "Rosa", texto: `Lo dejó en ${ag}: N.º ${num.trim()}.`, paso: "en_camino" },
        )
        toast.success(`Va por ${ag}, N.º ${num.trim()}.`)
        onHecho()
      }}
    >
      <Titulo sub="Está en el comprobante que te dio la agencia.">Anotar el N.º de envío</Titulo>
      <label htmlFor={id} className="text-xs font-semibold text-muted-foreground">
        N.º de envío de {ag}
      </label>
      <Input
        id={id}
        inputMode="numeric"
        autoComplete="off"
        value={num}
        aria-invalid={err || undefined}
        onChange={(ev) => {
          setNum(ev.target.value)
          setErr(false)
        }}
        placeholder="Está en el comprobante: 7 a 10 números"
        className="h-11"
      />
      {err ? <p className="text-sm text-destructive">Escribe el número del comprobante.</p> : null}
      <SofiAvisa on={sofi} set={setSofi} texto={texto} />
      <Botones>
        <Button type="submit" form={fid}>
          Guardar: va por {ag}
        </Button>
      </Botones>
    </form>
  )
}

function PasarPie({
  e,
  inicial,
  faltas,
  onCambiar,
  onHecho,
}: {
  e: Ent
  inicial: Destino
  faltas: Faltas
  onCambiar: (d: Destino) => void
  onHecho: () => void
}) {
  const { rubro } = useRuta()
  const todas = entregasDe(pedidosDe(rubro)).filter((y) => y.p.id !== e.p.id)
  const fecha = inicial.fecha ?? e.fecha
  const franja = inicial.franja !== undefined ? inicial.franja : (e.p.entrega.franja ?? FRANJAS[0])
  const agencia = e.p.entrega.tipo === "agencia"
  const quien = agencia
    ? null
    : inicial.rep
      ? inicial.rep
      : inicial.fecha && inicial.fecha !== e.fecha
        ? elegirSolo(todas, fecha, franja, faltas)
        : (e.p.entrega.repartidor ?? elegirSolo(todas, fecha, franja, faltas))
  const [sofi, setSofi] = useState(true)
  const lleno = !agencia && quien && franja ? ocupadas(todas, fecha, franja, quien) >= CUPO : false
  const fer = FERIADOS[fecha]
  return (
    <div className="flex flex-col gap-3">
      <Titulo>Pasar a otro día</Titulo>
      <p className="rounded-xl border px-3 py-2 text-sm">
        <span className="text-muted-foreground">Pasa a </span>
        <b className="capitalize">{corto(fecha)}</b>
        {franja ? ` · ${FRANJA_NOMBRE[franja] ?? franja}` : ""}
        {agencia ? ` · ${e.p.entrega.agencia}` : ` · ${quien ?? "sin repartidor"}`}
      </p>
      {lleno || fer ? (
        <p className="flex gap-2 text-sm text-warning">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {fer ? `Ese día es feriado (${fer}).` : `${quien} ya lleva ${CUPO} en esa franja: llevaría ${CUPO + 1}.`}
        </p>
      ) : null}
      <SofiAvisa on={sofi} set={setSofi} texto={textoAviso(e.p, fecha, franja, quien)} />
      <Botones>
        <Button variant="outline" onClick={() => onCambiar({ fecha, franja, rep: quien })}>
          Cambiar…
        </Button>
        <Button
          className="basis-40 grow-[2]"
          onClick={() => {
            pasar(rubro, e.p, fecha, franja, quien, sofi)
            toast.success(`Pasó al ${largo(fecha)}${franja ? `, ${franja}` : ""}`.replace(/\.?$/, "."), {
              description: sofi ? "Sofi le avisó a la clienta." : "No se le avisó a la clienta.",
            })
            onHecho()
          }}
        >
          Pasar al {corto(fecha)}
        </Button>
      </Botones>
    </div>
  )
}

/* ---------- El recojo ---------- */

function PasosRecojo({ p }: { p: Pedido }) {
  const pasos = ["Aprobado", "Por recoger", "Recogido"]
  const at = p.paso === "entregado" ? 3 : p.vuelta?.estado === "solicitado" ? 0 : 1
  return (
    <ol className="flex w-full items-start gap-1" aria-label="Pasos del recojo">
      {pasos.map((s, i) => (
        <li key={s} className="flex min-w-0 flex-1 flex-col gap-1" aria-current={i === at ? "step" : undefined}>
          <span className={cn("h-1.5 rounded-full", i < at ? "bg-success" : i === at ? "bg-primary" : "bg-muted")} />
          <span
            className={cn(
              "truncate text-[11px] leading-tight",
              i === at ? "font-semibold" : i < at ? "" : "text-muted-foreground",
            )}
          >
            {s}
          </span>
        </li>
      ))}
    </ol>
  )
}

function RecojoCorto({ e }: { e: Ent }) {
  const r = e.recojo!
  return (
    <p className="flex items-start gap-2 rounded-xl border p-3 text-sm">
      <Camera className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
      <span>
        <b>En la puerta:</b> {r.puerta}
      </span>
    </p>
  )
}

function RecojoB({ e }: { e: Ent }) {
  const r = e.recojo!
  return (
    <Bloque title={r.tipo === "cambio" ? (r.lleva ? "El cambio: lleva una y recoge otra" : "El cambio: lo recoge") : "La devolución: lo recoge"}>
      <dl className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2 rounded-xl border p-3 text-sm">
        <dt className="text-muted-foreground">Se recoge</dt>
        <dd className="flex items-start gap-1.5">
          <PackageOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          {r.recoge}
        </dd>
        {r.lleva ? (
          <>
            <dt className="text-muted-foreground">Se lleva</dt>
            <dd>{r.lleva}</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Por qué</dt>
        <dd>«{r.motivo}»</dd>
        <dt className="text-muted-foreground">En la puerta</dt>
        <dd className="flex items-start gap-1.5">
          <Camera className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden />
          {r.puerta}
        </dd>
        {r.devuelve ? (
          <>
            <dt className="text-muted-foreground">El dinero</dt>
            <dd>Se le devuelven {money(r.devuelve)} según tu política. Lo confirma una persona.</dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Lo aprobó</dt>
        <dd>{r.aprobo ? `${r.aprobo}, según la política de la tienda.` : "Falta aprobarlo: está en «Te toca»."}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">Del pedido {r.de}. La política y los pasos del caso están en Pedidos.</p>
    </Bloque>
  )
}

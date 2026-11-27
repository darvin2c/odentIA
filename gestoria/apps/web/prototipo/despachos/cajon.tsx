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
} from "@odentia/ui"
import { DetailDrawer, RadioChips } from "@odentia/ui-patterns"
import {
  Bike,
  Camera,
  Check,
  CircleAlert,
  MoreHorizontal,
  PackageOpen,
  Repeat,
  UserRound,
} from "lucide-react"
import { useId, useState } from "react"
import { AccionDrawer } from "../pedidos/acciones"
import { Bloque, Carrito, EntregaB, OrigenB, Pasos, Saldo } from "../pedidos/detalle"
import {
  type Accion,
  avisar,
  CANAL,
  cuentas,
  money,
  mover,
  PASO,
  type Pedido,
  pedidosDe,
  trasPagar,
} from "../pedidos/modelo"
import { ir, useRuta } from "../ruta"
import { elegirSolo, Foto, listo, PasarHoja, pasar, SofiAvisa, textoAviso } from "./hojas"
import {
  CUPO,
  corto,
  type Ent,
  ETAPA,
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
} from "./semana"

/**
 * El cajón de una entrega: arriba, el pedido detallado (las mismas secciones que la página del
 * pedido); abajo, fijo al pie, lo que toca, con sus campos y su único botón. Todo botón de
 * Despachos abre este cajón; ninguno actúa a ciegas. Soltar una entrega lo abre con «Pasar a…» ya
 * lleno como lo que toca.
 */

export interface Destino {
  fecha?: string
  franja?: string | null
  rep?: string | null
}

/** El número de cada repartidor (de ejemplo), para llamarlo desde el cajón. */
const TEL: Record<string, string> = { Kevin: "987 120 455", Jhon: "986 340 712" }

/** El día siguiente que la tienda reparte (sin feriado ni domingo). */
function siguienteDia(desde: string) {
  let f = sumar(desde < HOY ? HOY : desde, 1)
  while (FERIADOS[f] || new Date(`${f}T12:00:00Z`).getUTCDay() === 0) f = sumar(f, 1)
  return f
}

/** Confirmar el Yape con lo que dice la captura: la misma operación que en Pedidos. */
function confirmarYape(rubro: Parameters<typeof mover>[0], p: Pedido) {
  const g = p.pagos.find((x) => x.estado === "por_confirmar")
  if (!g) return
  const n = g.captura?.monto ?? g.monto
  const nombre = p.clienta.split(" ")[0]
  let queda = 0
  mover(
    rubro,
    p.id,
    (x) => {
      const y = x.pagos.find((z) => z.id === g.id)!
      y.estado = "confirmado"
      y.monto = n
      y.quien = "Rosa"
      x.toca = undefined
      const kk = cuentas(x)
      queda = kk.falta
      if (kk.falta > 0) x.cobro = "al_recibir"
      x.paso = trasPagar(x)
      avisar(
        x,
        "pagado",
        kk.falta > 0
          ? `¡Recibimos tus ${money(n)}, ${nombre}! Faltan ${money(kk.falta)}: los pagas al recibir.`
          : `¡Pago recibido, ${nombre}! Ya lo estamos preparando.`,
      )
    },
    {
      actor: "persona",
      quien: "Rosa",
      texto: `Confirmó el Yape de ${money(n)}.`,
      paso: "pagado",
    },
  )
  toast.success(
    queda > 0 ? `Confirmado. Falta cobrar ${money(queda)}, al recibir.` : "Pago confirmado.",
    { description: "Ya puede salir." },
  )
}

export function PedidoCajon({
  e,
  pasarA,
  faltas,
  onClose,
  onFalta,
  dock = true,
}: {
  e: Ent
  /** En la semana no hay ancho para la columna lateral: se abre encima. */
  dock?: boolean
  /** Al soltar una entrega: lo que toca es «Pasar a…», ya lleno. */
  pasarA?: Destino
  faltas: Faltas
  onClose: () => void
  onFalta?: (rep: string) => void
}) {
  const { rubro } = useRuta()
  const [accion, setAccion] = useState<{ a: Accion | "deshacer"; pago?: string } | null>(null)
  const [pasarHoja, setPasarHoja] = useState<Destino | null>(null)
  const p = e.p
  const x = p.entrega
  const k = cuentas(p)
  const r = e.recojo
  const salio = ["en_camino", "entregado"].includes(p.paso)
  const feriado = !!FERIADOS[e.fecha] && !salio
  // Lo que toca: soltar manda; si no, el botón de la entrega.
  const pasarInicial: Destino | undefined =
    pasarA ??
    (feriado
      ? { fecha: siguienteDia(e.fecha), franja: x.franja, rep: undefined }
      : undefined)
  const tipo = pasarInicial ? "pasar" : e.boton?.tipo
  const verPedido = () => ir("/pedidos", { extra: `p=${p.id}` })
  const cuando = `${e.fecha === HOY ? "hoy" : largo(e.fecha)}${x.franja ? ` · ${x.franja}` : ""}`
  const ev = p.eventos.filter((v) => v.paso || r).slice(-3)

  const menu = (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="size-11 shrink-0"
            aria-label="Más: corregir este pedido"
          />
        }
      >
        <MoreHorizontal aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        {!salio ? (
          <DropdownMenuItem className="min-h-11" onClick={() => setPasarHoja({})}>
            Pasar a…
          </DropdownMenuItem>
        ) : null}
        {!salio && !r ? (
          <DropdownMenuItem className="min-h-11" onClick={() => setAccion({ a: "cambiar" })}>
            Cambiar el pedido
          </DropdownMenuItem>
        ) : null}
        {p.paso === "en_camino" && x.tipo !== "agencia" ? (
          <DropdownMenuItem className="min-h-11" onClick={() => setAccion({ a: "no_entregado" })}>
            No se entregó
          </DropdownMenuItem>
        ) : null}
        {x.repartidor && e.fecha === HOY && onFalta && !salio ? (
          <DropdownMenuItem className="min-h-11" onClick={() => onFalta(x.repartidor!)}>
            {x.repartidor} no viene hoy
          </DropdownMenuItem>
        ) : null}
        <DropdownMenuItem className="min-h-11" onClick={verPedido}>
          Ver la página del pedido
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )

  const pie = (
    <div className="flex w-full flex-col gap-3" data-lo-que-toca>
      <div className="flex items-start gap-2">
        <p
          className={cn(
            "flex min-w-0 flex-1 items-start gap-2 rounded-xl px-3 py-2.5 text-sm",
            tipo ? "bg-warning-soft" : "bg-muted/70",
          )}
        >
          {tipo ? (
            <UserRound className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          ) : (
            <Check className="mt-0.5 size-4 shrink-0 text-success" aria-hidden />
          )}
          <span>
            {tipo ? <b>Te toca: </b> : null}
            {pasarA
              ? "Pasar esta entrega a donde la soltaste."
              : e.toca.texto.replace(/^Sigue solo: /, "")}
            {!tipo && e.toca.texto.startsWith("Sigue solo") ? (
              <span className="block text-xs text-muted-foreground">
                Sigue solo. Si hay que corregir algo, está en ⋯.
              </span>
            ) : null}
          </span>
        </p>
        {menu}
      </div>
      {tipo === "listo" ? <Empacar e={e} onHecho={onClose} /> : null}
      {tipo === "confirmar" ? (
        <ConfirmarPie
          p={p}
          onNo={() => setAccion({ a: "confirmar" })}
          onHecho={() => confirmarYape(rubro, p)}
        />
      ) : null}
      {tipo === "asignar" ? (
        <Asignar e={e} faltas={faltas} onOtroDia={() => setPasarHoja({})} />
      ) : null}
      {tipo === "numero" ? <Numero e={e} /> : null}
      {tipo === "pasar" && pasarInicial ? (
        <PasarPie
          key={JSON.stringify(pasarInicial)}
          e={e}
          inicial={pasarInicial}
          faltas={faltas}
          onCambiar={(d) => setPasarHoja(d)}
          onHecho={onClose}
        />
      ) : null}
    </div>
  )

  return (
    <>
      <DetailDrawer
        open
        dock={dock}
        size="lg"
        onClose={onClose}
        title={`${p.clienta} · ${p.id}`}
        description={`${x.zona} · ${cuando}${x.repartidor ? ` · ${x.repartidor}` : x.agencia ? ` · ${x.agencia}` : ""}`}
        footer={pie}
      >
        {/* Las secciones de Pedidos traen botones de 32 px: en el celular, 44 (va en el PR de shared). */}
        <div className="flex flex-col gap-5 max-sm:[&_button]:min-h-11 pointer-coarse:[&_button]:min-h-11">
          <section aria-label="La etapa" className="flex flex-col gap-3">
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant={ETAPA[e.etapa].tono}>{ETAPA[e.etapa].label}</Badge>
              <span
                className={cn(
                  "text-sm font-medium",
                  e.cobro.tono === "ok"
                    ? "text-success"
                    : e.cobro.tono === "falta"
                      ? "text-warning"
                      : "text-destructive",
                )}
              >
                {e.cobro.texto}
              </span>
              {r ? null : (
                <span className="ml-auto text-sm font-semibold tabular-nums">
                  {money(k.total)}
                </span>
              )}
            </div>
            {r ? <PasosRecojo p={p} /> : <Pasos p={p} />}
            {ev.length ? (
              <ol className="flex flex-col gap-1 text-xs text-muted-foreground">
                {ev.map((v) => (
                  <li key={v.id}>
                    <b className="font-medium text-foreground">
                      {r ? v.texto : v.paso ? PASO[v.paso].corto : ""}
                    </b>{" "}
                    · {v.quien} · {v.cuando}
                  </li>
                ))}
              </ol>
            ) : null}
          </section>
          {r ? <RecojoB e={e} /> : null}
          {r?.tipo === "devolucion" ? null : <Carrito p={p} />}
          {r ? null : <Saldo p={p} onAccion={(a, pago) => setAccion({ a, pago })} />}
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
          <Button variant="outline" className="h-11 self-start" onClick={verPedido}>
            Ver la página del pedido
          </Button>
        </div>
      </DetailDrawer>
      {accion ? (
        <AccionDrawer
          p={p}
          accion={accion.a}
          pagoId={accion.pago}
          onClose={() => setAccion(null)}
        />
      ) : null}
      {pasarHoja ? (
        <PasarHoja
          key={JSON.stringify(pasarHoja)}
          e={e}
          inicial={pasarHoja}
          faltas={faltas}
          onClose={() => {
            setPasarHoja(null)
            onClose()
          }}
        />
      ) : null}
    </>
  )
}

/* ---------- Lo que toca, al pie ---------- */

function Empacar({ e, onHecho }: { e: Ent; onHecho: () => void }) {
  const { rubro } = useRuta()
  const x = e.p.entrega
  const va = e.p.lineas.filter((l) => !l.vuelve)
  const agencia = x.tipo === "agencia"
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-semibold text-muted-foreground">Va en el paquete</span>
      <ul className="flex flex-col gap-1.5">
        {va.map((l) => (
          <li key={l.id} className="flex items-center gap-2.5 text-sm">
            <Foto e={{ ...e, p: { ...e.p, lineas: [l] } }} className="size-10" />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{l.nombre}</span>
              <span className="block truncate text-muted-foreground">
                {l.variante} · × {l.qty}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {e.recojo?.lleva ? (
        <p className="flex items-start gap-2 text-sm">
          <Repeat className="mt-0.5 size-4 shrink-0 text-primary" aria-hidden />
          <span>
            <b>Y recoge:</b> {e.recojo.recoge}.
          </span>
        </p>
      ) : null}
      {e.falta && e.p.cobro === "al_recibir" ? (
        <p className="text-sm text-muted-foreground">
          {x.repartidor} cobra {money(e.falta)} en la puerta.
        </p>
      ) : null}
      <Button
        className="h-11 w-full whitespace-nowrap"
        onClick={() => {
          listo(rubro, e)
          onHecho()
        }}
      >
        {agencia
          ? `Listo: lo dejé en ${x.agencia ?? "la agencia"}`
          : `Listo: se lo di a ${x.repartidor}`}
      </Button>
    </div>
  )
}

function ConfirmarPie({
  p,
  onNo,
  onHecho,
}: {
  p: Pedido
  onNo: () => void
  onHecho: () => void
}) {
  const g = p.pagos.find((x) => x.estado === "por_confirmar")
  if (!g) return null
  const k = cuentas(p)
  const leido = g.captura?.monto ?? g.monto
  const queda = Math.max(0, k.total - k.confirmado - leido)
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-stretch gap-3">
        <div
          className="flex w-28 shrink-0 flex-col items-center justify-center gap-0.5 rounded-xl border bg-muted/50 p-2 text-center"
          aria-label="La captura que mandó la clienta"
        >
          <span className="text-[11px] text-muted-foreground">Captura de Yape</span>
          <span className="font-heading text-xl font-bold tabular-nums">{money(leido)}</span>
          <span className="truncate text-[11px]">{g.captura?.nombre}</span>
          <span className="text-[11px] text-muted-foreground">{g.captura?.hora}</span>
        </div>
        <p className="flex-1 self-center text-sm">
          Dice <b>{money(leido)}</b>. El pedido es <b>{money(k.total)}</b>
          {queda > 0 ? (
            <>
              : faltarían <b>{money(queda)}</b>, al recibir.
            </>
          ) : (
            "."
          )}{" "}
          <span className="text-muted-foreground">Míralo en tu Yape antes de confirmar.</span>
        </p>
      </div>
      <div className="flex gap-2">
        <Button variant="outline" className="h-11 flex-1 whitespace-nowrap" onClick={onNo}>
          No coincide…
        </Button>
        <Button className="h-11 flex-1 whitespace-nowrap" onClick={onHecho}>
          Confirmar {money(leido)}
        </Button>
      </div>
    </div>
  )
}

function Asignar({
  e,
  faltas,
  onOtroDia,
}: {
  e: Ent
  faltas: Faltas
  onOtroDia: () => void
}) {
  const { rubro } = useRuta()
  const todas = entregasDe(pedidosDe(rubro)).filter((y) => y.p.id !== e.p.id)
  const franja = e.p.entrega.franja
  const salen = REPARTIDORES.filter((r) => !(faltas[e.fecha] ?? []).includes(r))
  const [rep, setRep] = useState<string>(salen[0] ?? "Kevin")
  const lleva = (r: string) => ocupadas(todas, e.fecha, franja, r)
  const id = useId()
  return (
    <div className="flex flex-col gap-2">
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
      <div className="flex gap-2">
        <Button variant="outline" className="h-11 whitespace-nowrap" onClick={onOtroDia}>
          Otro día…
        </Button>
        <Button
          className="h-11 flex-1 whitespace-nowrap"
          onClick={() => {
            pasar(rubro, e.p, e.fecha, franja, rep, false)
            toast.success(`Lo lleva ${rep}.`, { description: "Le llega el aviso a su app." })
          }}
        >
          Que lo lleve {rep}
        </Button>
      </div>
    </div>
  )
}

function Numero({ e }: { e: Ent }) {
  const { rubro } = useRuta()
  const [num, setNum] = useState("")
  const [sofi, setSofi] = useState(true)
  const [err, setErr] = useState(false)
  const n = e.p.clienta.split(" ")[0]
  const ag = e.p.entrega.agencia ?? "la agencia"
  const texto = `${n}, tu pedido ${e.p.id} va por ${ag}, número de envío ${num || "…"}. Lo recoges en su agencia de ${e.p.entrega.zona.split(",")[0]}.`
  const id = useId()
  return (
    <form
      className="flex flex-col gap-2"
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
          {
            actor: "persona",
            quien: "Rosa",
            texto: `Lo dejó en ${ag}: N.º ${num.trim()}.`,
            paso: "en_camino",
          },
        )
        toast.success(`Va por ${ag}, N.º ${num.trim()}.`)
      }}
    >
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
      <Button type="submit" className="h-11 w-full whitespace-nowrap">
        Guardar: va por {ag}
      </Button>
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
  const franja =
    inicial.franja !== undefined ? inicial.franja : (e.p.entrega.franja ?? FRANJAS[0])
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
    <div className="flex flex-col gap-2">
      <p className="rounded-xl border px-3 py-2 text-sm">
        <span className="text-muted-foreground">Pasa a </span>
        <b className="capitalize">{corto(fecha)}</b>
        {franja ? ` · ${FRANJA_NOMBRE[franja] ?? franja}` : ""}
        {agencia ? ` · ${e.p.entrega.agencia}` : ` · ${quien ?? "sin repartidor"}`}
      </p>
      {lleno || fer ? (
        <p className="flex gap-2 text-sm text-warning">
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          {fer
            ? `Ese día es feriado (${fer}).`
            : `${quien} ya lleva ${CUPO} en esa franja: llevaría ${CUPO + 1}.`}
        </p>
      ) : null}
      <SofiAvisa on={sofi} set={setSofi} texto={textoAviso(e.p, fecha, franja, quien)} />
      <div className="flex gap-2">
        <Button
          variant="outline"
          className="h-11 whitespace-nowrap"
          onClick={() => onCambiar({ fecha, franja, rep: quien })}
        >
          Cambiar…
        </Button>
        <Button
          className="h-11 flex-1 whitespace-nowrap"
          onClick={() => {
            pasar(rubro, e.p, fecha, franja, quien, sofi)
            toast.success(`Pasó al ${largo(fecha)}${franja ? `, ${franja}` : ""}.`, {
              description: sofi ? "Sofi le avisó a la clienta." : "No se le avisó a la clienta.",
            })
            onHecho()
          }}
        >
          Pasar al {corto(fecha)}
        </Button>
      </div>
    </div>
  )
}

/* ---------- El recojo ---------- */

function PasosRecojo({ p }: { p: Pedido }) {
  const pasos = ["Aprobado", "Por recoger", "Recogido"]
  const at = p.paso === "entregado" ? 3 : 1
  return (
    <ol className="flex w-full items-start gap-1" aria-label="Pasos del recojo">
      {pasos.map((s, i) => (
        <li
          key={s}
          className="flex min-w-0 flex-1 flex-col gap-1"
          aria-current={i === at ? "step" : undefined}
        >
          <span
            className={cn(
              "h-1.5 rounded-full",
              i < at ? "bg-success" : i === at ? "bg-primary" : "bg-muted",
            )}
          />
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

function RecojoB({ e }: { e: Ent }) {
  const r = e.recojo!
  return (
    <Bloque title={r.tipo === "cambio" ? "El cambio: lleva una y recoge otra" : "La devolución"}>
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
            <dt className="text-muted-foreground">La plata</dt>
            <dd>
              Se le devuelven {money(r.devuelve)} cuando vuelva a la tienda y se revise. Lo
              confirma una persona.
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Lo aprobó</dt>
        <dd>{r.aprobo}, según la política de la tienda.</dd>
      </dl>
      <Button
        variant="outline"
        className="h-11 self-start"
        onClick={() => ir("/pedidos", { extra: `p=${r.de}` })}
      >
        Ver el pedido original {r.de}
      </Button>
    </Bloque>
  )
}

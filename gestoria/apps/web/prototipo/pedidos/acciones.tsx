import { Checkbox, cn, Input, toast } from "@odentia/ui"
import { Textarea } from "@odentia/ui/components/textarea"
import { AgentMark, RadioChips } from "@odentia/ui-patterns"
import { Ampliable, ImagenPago } from "./ejemplos"
import { Hoja } from "./hoja"
import { CircleAlert, Link2, MessageCircle } from "lucide-react"
import { type ReactNode, useId, useState } from "react"
import { DISTRITOS, foto, RUBROS } from "../datos"
import { useRuta } from "../ruta"
import { ExcepcionDrawer, RevisarDrawer } from "./vuelta-ui"
import {
  type Accion,
  agregar,
  asignarSolo,
  avisar,
  cuentas,
  type Medio,
  money,
  mover,
  nuevoId,
  type Pedido,
  pedidosDe,
  trasPagar,
} from "./modelo"

/** Un campo con su nombre arriba y su ayuda debajo, como los de la app. */
export function Campo({
  label,
  help,
  children,
}: {
  label: string
  help?: ReactNode
  children: (id: string) => ReactNode
}) {
  const id = useId()
  return (
    <div className="flex flex-col gap-2">
      <span id={id} className="text-sm font-medium">
        {label}
      </span>
      {children(id)}
      {help ? <p className="text-xs text-muted-foreground">{help}</p> : null}
    </div>
  )
}

/** Lo que dirá Sofi si se marca: siempre a la vista antes de mandarlo. */
function SofiAvisa({ on, set, texto }: { on: boolean; set: (v: boolean) => void; texto: string }) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border p-3">
      <label className="flex items-start gap-2.5 text-sm">
        <Checkbox checked={on} onCheckedChange={(v) => set(!!v)} className="mt-0.5" />
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">Que Sofi le avise por WhatsApp</span>
          <span className="text-xs text-muted-foreground">Si no lo marcas, no le llega nada.</span>
        </span>
      </label>
      {on ? (
        <p className="ml-6.5 rounded-lg bg-muted px-3 py-2 text-sm">
          <MessageCircle className="mr-1.5 inline size-3.5 text-muted-foreground" aria-hidden />
          {texto}
        </p>
      ) : null}
    </div>
  )
}

function Resumen({ rows }: { rows: [string, string, ("falta" | "favor" | "ok")?][] }) {
  return (
    <dl className="flex flex-col divide-y rounded-xl border text-sm">
      {rows.map(([k, v, tone]) => (
        <div key={k} className="flex items-center justify-between gap-3 px-3 py-2">
          <dt className={cn("text-muted-foreground", tone && "font-semibold text-foreground")}>
            {k}
          </dt>
          <dd
            className={cn(
              "tabular-nums",
              tone === "falta" && "font-semibold text-warning",
              tone === "favor" && "font-semibold text-success",
              tone === "ok" && "font-semibold",
            )}
          >
            {v}
          </dd>
        </div>
      ))}
    </dl>
  )
}

/* ---------- Empacar: se confirma en el cajón, con lo que va en el paquete a la vista ---------- */

/**
 * «Listo: se lo di a Kevin». Pasa a «Por salir» y a Kevin le llega a su app; si va por agencia,
 * queda en la agencia. La misma operación desde Pedidos, Inicio y Despachos. El aviso trae
 * «Deshacer» por si se tocó antes de tiempo.
 */
export function empacar(rubro: Parameters<typeof mover>[0], p: Pedido) {
  const agencia = p.entrega.tipo === "agencia"
  const rep = agencia ? (p.entrega.agencia ?? "la agencia") : (p.entrega.repartidor ?? "el repartidor")
  mover(
    rubro,
    p.id,
    (x) => {
      x.paso = agencia ? "en_camino" : "por_salir"
      x.toca = undefined
    },
    {
      actor: "persona",
      quien: "Rosa",
      texto: agencia ? `Lo dejó en ${rep}.` : `Lo empacó y se lo dio a ${rep}. Le llegó a su app.`,
      paso: agencia ? "en_camino" : "por_salir",
    },
  )
  toast.success(agencia ? `${p.clienta.split(" ")[0]}: en ${rep}.` : `Listo: lo tiene ${rep}. Sigue solo.`, {
    description: agencia ? undefined : `Sale cuando ${rep} toque «Salí» en su app.`,
    action: {
      label: "Deshacer",
      onClick: () =>
        mover(
          rubro,
          p.id,
          (x) => {
            x.paso = "preparando"
          },
          { actor: "persona", quien: "Rosa", texto: "Deshizo «Listo»: todavía no salió." },
        ),
    },
  })
}

/**
 * Confirmar lo que llegó de un Yape o Plin: la misma operación desde el cajón de la acción, la
 * página o el cajón «pedido + lo que toca». Si falta una parte, Sofi la cobra con su link; si sale
 * hoy, gestorIA le asigna al repartidor de siempre.
 */
export function confirmarPago(
  rubro: Parameters<typeof mover>[0],
  p: Pedido,
  n: number,
  sofi = true,
  quien = "Lucía",
) {
  const pago = p.pagos.find((x) => x.estado === "por_confirmar")
  if (!pago) return
  const k = cuentas(p)
  const queda = Math.max(0, k.total - k.confirmado - n)
  const nombre = p.clienta.split(" ")[0]!
  mover(
    rubro,
    p.id,
    (x) => {
      const g = x.pagos.find((y) => y.id === pago.id)!
      g.estado = "confirmado"
      g.monto = n
      g.quien = quien
      x.toca = undefined
      x.paso = trasPagar(x)
      if (sofi && cuentas(x).falta <= 0)
        avisar(x, "pagado", `¡Pago recibido, ${nombre}! Ya lo estamos preparando.`)
    },
    {
      actor: "persona",
      quien,
      texto: `Confirmó el ${MEDIOCORTO[pago.medio]} de ${money(n)}: lo que llegó.`,
      paso: "pagado",
    },
  )
  if (queda > 0)
    mover(
      rubro,
      p.id,
      (x) => {
        x.cobro = "link"
        if (sofi)
          avisar(x, "link", textoFalta(nombre, n, queda, RUBROS[rubro].store.slug))
      },
      {
        actor: "sofi",
        quien: "Sofi",
        texto: sofi
          ? `Le escribió sola a ${nombre} para cobrar los ${money(queda)} que faltan, con su link. Quedan en el saldo; sin pago confirmado no se entrega.`
          : `Los ${money(queda)} que faltan quedan en el saldo. A ${nombre} no le llegó nada.`,
      },
    )
  // Si sale hoy, gestorIA le asigna al repartidor de siempre.
  mover(rubro, p.id, (x) => {
    if (x.paso !== "preparando") return
    const a = asignarSolo(x)
    if (a)
      x.eventos.push({
        id: nuevoId("e"),
        cuando: "Hoy · ahora",
        actor: "gestoria",
        quien: "gestorIA",
        texto: `Sale hoy: pasó a Preparando. ${a}`,
        paso: "preparando",
      })
  })
  toast.success(
    queda > 0
      ? `Confirmado. Sofi le cobra los ${money(queda)} que faltan.`
      : "Pago confirmado. El pedido sigue solo.",
  )
}

/* ---------- Ver y confirmar un pago (Yape o Plin al número de la tienda) ---------- */

function ConfirmarPago({ p, onClose }: { p: Pedido; onClose: () => void }) {
  const { rubro } = useRuta()
  const pago = p.pagos.find((x) => x.estado === "por_confirmar")
  const k = cuentas(p)
  const leido = pago?.captura?.monto ?? pago?.monto ?? 0
  const distinto = pago ? leido !== pago.monto : false
  const [modo, setModo] = useState<"confirmar" | "no">("confirmar")
  const [llego, setLlego] = useState(String(leido))
  const [motivo, setMotivo] = useState<string | null>(null)
  const [sofi, setSofi] = useState(true)
  const [err, setErr] = useState<string | null>(null)
  if (!pago) return null
  const n = Number(llego.replace(",", ".")) || 0
  const queda = Math.max(0, k.total - k.confirmado - n)
  const nombre = p.clienta.split(" ")[0]
  return (
    <Hoja
      open
      onClose={onClose}
      title={modo === "no" ? "No coincide" : "Ver y confirmar el pago"}
      description={`Pedido ${p.id} · ${p.clienta}`}
      submitLabel={modo === "no" ? "Guardar: no coincide" : `Confirmar ${money(n)}`}
      secondaryAction={
        modo === "confirmar"
          ? { label: "No coincide", onClick: () => setModo("no") }
          : { label: "Volver", onClick: () => setModo("confirmar") }
      }
      error={err}
      onSubmit={(e) => {
        e.preventDefault()
        if (modo === "no") {
          if (!motivo) return setErr("Elige por qué no coincide.")
          mover(
            rubro,
            p.id,
            (x) => {
              const g = x.pagos.find((y) => y.id === pago.id)!
              g.estado = "no_coincide"
              g.motivo = motivo
              x.paso = "por_pagar"
              x.toca = undefined
              if (sofi)
                avisar(
                  x,
                  "falla",
                  `${nombre}, no encontramos tu Yape de ${money(leido)}. ¿Me mandas otra captura o pagas en tu link?`,
                )
            },
            {
              actor: "persona",
              quien: "Lucía",
              texto: `Marcó el Yape como «no coincide»: ${motivo.toLowerCase()}.${sofi ? " Sofi le escribió a la clienta." : " A la clienta no le llegó nada."}`,
              paso: "por_pagar",
            },
          )
          toast.success("Quedó como «no coincide». El pedido sigue por pagar.")
          return onClose()
        }
        if (n <= 0) return setErr("Escribe cuánto llegó.")
        confirmarPago(rubro, p, n, sofi)
        onClose()
      }}
    >
      <div className="grid grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)] items-start gap-3">
        <Ampliable titulo={`Captura de ${MEDIOCORTO[pago.medio]} · ${p.id}`}>
          <ImagenPago p={p} g={pago} tienda={RUBROS[rubro].store.name} />
        </Ampliable>
        <div className="flex min-w-0 flex-col gap-2 text-sm" aria-label="La comparación">
          <span className="text-xs font-medium text-muted-foreground">
            Captura de {MEDIOCORTO[pago.medio]} · la leyó Sofi
          </span>
          <dl className="flex flex-col divide-y rounded-xl border">
            <div className="flex flex-col px-3 py-2">
              <dt className="text-xs text-muted-foreground">La captura dice</dt>
              <dd className="font-heading text-xl font-bold tabular-nums">{money(leido)}</dd>
            </div>
            <div className="flex flex-col px-3 py-2">
              <dt className="text-xs text-muted-foreground">
                {k.confirmado ? `El pedido es ${money(k.total)}; ya pagó` : "El pedido es"}
              </dt>
              <dd className="font-semibold tabular-nums">
                {money(k.confirmado ? k.confirmado : k.total)}
              </dd>
            </div>
            <div className="flex flex-col px-3 py-2">
              <dt className="text-xs text-muted-foreground">
                {Math.max(0, k.total - k.confirmado - leido) > 0 ? "Faltarían" : "Coincide"}
              </dt>
              <dd
                className={cn(
                  "font-semibold tabular-nums",
                  Math.max(0, k.total - k.confirmado - leido) > 0 ? "text-warning" : "text-success",
                )}
              >
                {Math.max(0, k.total - k.confirmado - leido) > 0
                  ? money(k.total - k.confirmado - leido)
                  : "Paga todo"}
              </dd>
            </div>
          </dl>
          {distinto ? (
            <p className="flex items-start gap-1.5 text-warning">
              <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
              <span>No coincide con lo que pide el pedido: revísalo tú.</span>
            </p>
          ) : null}
        </div>
      </div>
      <p className="text-sm">
        Abre tu app de {MEDIOCORTO[pago.medio]} y mira que entraron <b>{money(leido)}</b> de{" "}
        <b>{pago.captura?.nombre}</b>. Solo tú lo puedes ver: {MEDIOCORTO[pago.medio]} no le avisa a
        nadie.
      </p>
      {modo === "confirmar" ? (
        <>
          <Campo
            label="¿Cuánto llegó?"
            help={
              queda > 0
                ? `Se confirma lo que llegó. Los ${money(queda)} que faltan quedan en el saldo y Sofi se los cobra con su link.`
                : "Con esto el pedido queda pagado y sigue solo."
            }
          >
            {(id) => (
              <Input
                aria-labelledby={id}
                inputMode="decimal"
                value={llego}
                onChange={(e) => setLlego(e.target.value)}
                className="max-w-40"
              />
            )}
          </Campo>
          <SofiAvisa
            on={sofi}
            set={setSofi}
            texto={
              queda > 0
                ? `«${textoFalta(nombre, n, queda, RUBROS[rubro].store.slug)}»`
                : `«¡Pago recibido, ${nombre}! Ya lo estamos preparando.»`
            }
          />
        </>
      ) : (
        <>
          <Campo label="¿Por qué no coincide?">
            {(id) => (
              <RadioChips
                aria-labelledby={id}
                value={motivo}
                invalid={!!err && !motivo}
                options={["No llegó a mi cuenta", "Es de otro pedido", "La captura no se lee"].map(
                  (o) => ({ value: o, label: o }),
                )}
                onChange={(v) => {
                  setMotivo(v)
                  setErr(null)
                }}
              />
            )}
          </Campo>
          <SofiAvisa
            on={sofi}
            set={setSofi}
            texto={`«${nombre}, no encontramos tu Yape de ${money(leido)}. ¿Me mandas otra captura o pagas en tu link?»`}
          />
          <p className="text-xs text-muted-foreground">
            El pedido sigue separado hasta que venza. La captura queda guardada con tu motivo.
          </p>
        </>
      )}
    </Hoja>
  )
}

/** Lo que Sofi le escribe sola a la clienta cuando falta una parte. */
function textoFalta(nombre: string, llego: number, falta: number, slug: string) {
  return `¡Recibimos tus ${money(llego)}, ${nombre}! Faltan ${money(falta)}: los pagas aquí con Yape o tarjeta. ${slug}.gestoria24.com/carrito/F${Math.round(falta)}`
}

const MEDIOCORTO: Record<Medio, string> = {
  link: "la pasarela",
  yape: "Yape",
  plin: "Plin",
  efectivo: "efectivo",
  pos: "POS",
}

/* ---------- Pasar a… y Asignar ---------- */

const DIAS = ["Hoy", "Vie 28", "Sáb 29"] as const
const FRANJAS = ["9 a 1 p. m.", "2 a 6 p. m.", "6 a 9 p. m."] as const
const REPARTIDORES = ["Kevin", "Jhon", "Lo recoge en tienda"] as const

function PasarA({ p, onClose, asignar }: { p: Pedido; onClose: () => void; asignar?: boolean }) {
  const { rubro } = useRuta()
  const [dia, setDia] = useState<string | null>(
    p.entrega.dia && DIAS.includes(p.entrega.dia as never)
      ? p.entrega.dia
      : asignar
        ? "Hoy"
        : "Vie 28",
  )
  // Sin repartidor libre en su franja: se propone la siguiente franja con quien sí puede.
  const sinLibre = !!asignar && p.toca?.accion === "asignar"
  const [franja, setFranja] = useState<string | null>(
    sinLibre ? "6 a 9 p. m." : (p.entrega.franja ?? "2 a 6 p. m."),
  )
  const [rep, setRep] = useState<string | null>(
    sinLibre ? "Jhon" : (p.entrega.repartidor ?? (asignar ? "Kevin" : null)),
  )
  const [sofi, setSofi] = useState(!asignar || sinLibre)
  const nombre = p.clienta.split(" ")[0]
  const texto = `«${nombre}, tu pedido llega ${dia === "Hoy" ? "hoy" : `el ${dia?.toLowerCase()}`} entre ${franja}${rep && rep !== "Lo recoge en tienda" ? ` con ${rep}` : ""}.»`
  return (
    <Hoja
      open
      onClose={onClose}
      title={sinLibre ? "No hay repartidor libre" : asignar ? "Cambiar repartidor" : "Pasar a…"}
      description={
        sinLibre
          ? `Pedido ${p.id} · ${p.clienta} · ${p.entrega.zona}. De ${p.entrega.franja} Kevin y Jhon van llenos: elige otra franja, otro día o que lo recoja.`
          : `Pedido ${p.id} · ${p.clienta} · ${p.entrega.zona}`
      }
      submitLabel={sinLibre ? "Guardar" : asignar ? "Cambiar" : "Pasar"}
      onSubmit={(e) => {
        e.preventDefault()
        mover(
          rubro,
          p.id,
          (x) => {
            x.entrega.dia = dia
            x.entrega.franja = franja
            x.entrega.repartidor = rep === "Lo recoge en tienda" ? null : rep
            if (rep === "Lo recoge en tienda") x.entrega.tipo = "recojo"
            x.toca = undefined
            x.noEntregado = undefined
            if (dia === "Hoy" && x.paso === "pagado") x.paso = "preparando"
            if (sofi) avisar(x, "cambio", texto.slice(1, -1))
          },
          {
            actor: "persona",
            quien: "Rosa",
            texto: asignar
              ? `${sinLibre ? "Eligió" : "Cambió a"} ${rep}, ${dia?.toLowerCase()} de ${franja}.${sofi ? " Sofi le avisó." : ""}`
              : `Lo pasó a ${dia?.toLowerCase()}, de ${franja}${rep ? `, con ${rep}` : ""}.${sofi ? " Sofi le avisó." : ""}`,
            paso: undefined,
          },
        )
        toast.success(
          asignar ? `Lo lleva ${rep}. Cuando lo empaques, es un toque.` : `Pasó a ${dia?.toLowerCase()}.`,
        )
        onClose()
      }}
    >
      <Campo label="Día">
        {(id) => (
          <RadioChips
            aria-labelledby={id}
            value={dia}
            options={DIAS.map((d) => ({ value: d, label: d }))}
            onChange={setDia}
          />
        )}
      </Campo>
      <Campo label="Franja">
        {(id) => (
          <RadioChips
            aria-labelledby={id}
            value={franja}
            options={FRANJAS.map((d) => ({ value: d, label: d }))}
            onChange={setFranja}
          />
        )}
      </Campo>
      <Campo
        label="Quién lo lleva"
        help="Kevin y Jhon reparten con gestorIA Reparto: les llega el aviso a su app."
      >
        {(id) => (
          <RadioChips
            aria-labelledby={id}
            value={rep}
            options={REPARTIDORES.map((d) => ({ value: d, label: d }))}
            onChange={setRep}
          />
        )}
      </Campo>
      <SofiAvisa on={sofi} set={setSofi} texto={texto} />
    </Hoja>
  )
}

/* ---------- Cambiar (antes de salir: el mismo pedido) ---------- */

function Cambiar({ p, onClose }: { p: Pedido; onClose: () => void }) {
  const { rubro } = useRuta()
  const R = RUBROS[rubro]
  const l = p.lineas[0]!
  const prod = R.products().find((x) => x.id === l.pid)
  const [colorName, tallaVieja] = l.variante.split(" · ")
  const [talla, setTalla] = useState<string | null>(tallaVieja ?? null)
  const [zona, setZona] = useState<string | null>(p.entrega.zona)
  const [sofi, setSofi] = useState(true)
  const envio = DISTRITOS.find(([d]) => d === zona)?.[1] ?? p.entrega.envio
  const k = cuentas(p)
  const nuevo = k.productos + envio
  const dif = nuevo - k.confirmado - k.porConfirmar
  return (
    <Hoja
      open
      onClose={onClose}
      title={`Cambiar el pedido ${p.id}`}
      description="Es el mismo pedido: su número, su pago y su historia. Lo que cambia mueve solo la diferencia."
      submitLabel="Guardar cambios"
      isDirty={talla !== tallaVieja || zona !== p.entrega.zona}
      onSubmit={(e) => {
        e.preventDefault()
        mover(
          rubro,
          p.id,
          (x) => {
            x.lineas[0]!.variante = [colorName, talla].filter(Boolean).join(" · ")
            x.entrega.zona = zona ?? x.entrega.zona
            x.entrega.envio = envio
            if (sofi)
              avisar(
                x,
                "cambio",
                `Listo, ${p.clienta.split(" ")[0]}: cambiamos tu pedido${talla !== tallaVieja ? ` a la talla ${talla}` : ""}. ${dif > 0 ? `Faltan ${money(dif)}, al recibir.` : "No pagas nada más."}`,
              )
          },
          {
            actor: "persona",
            quien: "Lucía",
            texto: `Cambió${talla !== tallaVieja ? ` la talla ${tallaVieja} → ${talla}` : ""}${zona !== p.entrega.zona ? ` y la zona a ${zona} (envío ${money(p.entrega.envio)} → ${money(envio)})` : ""}. ${talla !== tallaVieja ? `La ${tallaVieja} volvió al stock.` : ""}`,
          },
        )
        toast.success("Cambiado. Mismo número, mismo pago.")
        onClose()
      }}
    >
      <div className="flex items-center gap-3 rounded-xl border p-3">
        {l.foto ? (
          <img src={foto(l.foto)} alt="" className="size-12 rounded-lg object-cover" />
        ) : null}
        <span className="text-sm">
          <b>{l.nombre}</b>
          <span className="block text-muted-foreground">{l.variante}</span>
        </span>
      </div>
      {prod && prod.sizes.length > 1 ? (
        <Campo
          label={R.col ?? "Talla"}
          help={
            talla !== tallaVieja
              ? `La ${tallaVieja} vuelve a tu stock. De la ${talla} quedan 2.`
              : undefined
          }
        >
          {(id) => (
            <RadioChips
              aria-labelledby={id}
              value={talla}
              options={prod.sizes.slice(0, 6).map((s) => ({ value: s, label: s }))}
              onChange={setTalla}
            />
          )}
        </Campo>
      ) : null}
      <Campo label="Zona de entrega">
        {(id) => (
          <RadioChips
            aria-labelledby={id}
            value={zona}
            options={DISTRITOS.slice(0, 4).map(([d, c]) => ({
              value: d,
              label: `${d} · ${money(c)}`,
            }))}
            onChange={setZona}
          />
        )}
      </Campo>
      <Resumen
        rows={[
          ["Total nuevo", money(nuevo)],
          ["Pagado", money(k.confirmado)],
          dif > 0
            ? ["Falta cobrar · al recibir", money(dif), "falta"]
            : dif < 0
              ? ["A favor de la clienta", money(-dif), "favor"]
              : ["Falta cobrar", "Nada", "ok"],
        ]}
      />
      <SofiAvisa
        on={sofi}
        set={setSofi}
        texto={`«Listo, ${p.clienta.split(" ")[0]}: cambiamos tu pedido. ${dif > 0 ? `Faltan ${money(dif)}, al recibir.` : "No pagas nada más."}»`}
      />
    </Hoja>
  )
}

/* ---------- No se entregó ---------- */

function NoEntregado({ p, onClose }: { p: Pedido; onClose: () => void }) {
  const { rubro } = useRuta()
  const [motivo, setMotivo] = useState<string | null>("No estaba")
  const [que, setQue] = useState<string | null>("Sofi le escribe para elegir otro día")
  const nombre = p.clienta.split(" ")[0]
  return (
    <Hoja
      open
      dock={false}
      onClose={onClose}
      title="No se entregó"
      description={`Pedido ${p.id} · ${p.clienta}`}
      submitLabel="Guardar"
      onSubmit={(e) => {
        e.preventDefault()
        mover(
          rubro,
          p.id,
          (x) => {
            x.paso = "por_salir"
            x.noEntregado = `${motivo}.`
            x.entrega.dia = "Vie 28"
            if (que?.startsWith("Sofi"))
              avisar(
                x,
                "falla",
                `No te encontramos, ${nombre}. ¿Te lo llevamos mañana entre 9 y 1 p. m. o entre 2 y 6 p. m.?`,
              )
          },
          {
            actor: "persona",
            quien: "Rosa",
            texto: `«No se entregó»: ${motivo?.toLowerCase()}. Volvió a la tienda.${que?.startsWith("Sofi") ? " Sofi le escribió para otro día." : ""}`,
            paso: "por_salir",
          },
        )
        toast.success("Volvió a «Por salir». Lo cobrado no cambia.")
        onClose()
      }}
    >
      <Campo label="¿Qué pasó?">
        {(id) => (
          <RadioChips
            aria-labelledby={id}
            value={motivo}
            options={["No estaba", "Dirección equivocada", "No quiso recibirlo", "No pagó"].map(
              (o) => ({ value: o, label: o }),
            )}
            onChange={setMotivo}
          />
        )}
      </Campo>
      <Campo label="¿Y ahora?">
        {(id) => (
          <RadioChips
            aria-labelledby={id}
            value={que}
            options={["Sofi le escribe para elegir otro día", "Lo paso yo a otro día"].map((o) => ({
              value: o,
              label: o,
            }))}
            onChange={setQue}
          />
        )}
      </Campo>
      <p className="text-sm text-muted-foreground">
        El pedido vuelve a «Por salir». Lo pagado sigue pagado y lo que vuelve no se suma al stock:
        sigue separado para {nombre}.
      </p>
    </Hoja>
  )
}

/* ---------- Cambio o devolución (después de entregar: un pedido nuevo, enlazado) ---------- */

function CambioDevolucion({ p, onClose }: { p: Pedido; onClose: () => void }) {
  const { rubro } = useRuta()
  const R = RUBROS[rubro]
  const l = p.lineas[0]!
  const prod = R.products().find((x) => x.id === l.pid)
  const [colorName, tallaVieja] = l.variante.split(" · ")
  const idx = prod?.sizes.indexOf(tallaVieja ?? "") ?? -1
  const [por, setPor] = useState<string | null>(p.cambioPide ? "No le gustó" : "Le quedó chica")
  const [que, setQue] = useState<string | null>("cambio")
  const [talla, setTalla] = useState<string | null>(prod?.sizes[idx + 1] ?? tallaVieja ?? null)
  const [paga, setPaga] = useState<string | null>("La tienda")
  const [sofi, setSofi] = useState(true)
  const envio = paga === "La tienda" ? 0 : p.entrega.envio
  // Lo que pidió en el chat, si es otro modelo: cuesta distinto y por eso lo decide una persona.
  const pide = p.cambioPide
  const sale = pide ?? { ...l, variante: [colorName, talla].filter(Boolean).join(" · ") }
  const dif = sale.precio - l.precio
  const cobrar = Math.max(0, dif) + envio
  const queSale = pide ? `${pide.nombre} ${pide.variante}` : `la ${talla}`
  const nombre = p.clienta.split(" ")[0]
  const avisoCambio = `Listo, ${nombre}: el viernes entre 2 y 6 p. m. ${p.entrega.repartidor ?? "Kevin"} te lleva ${queSale} y recoge la ${tallaVieja ?? "que vuelve"}. ${cobrar ? `Son ${money(cobrar)} de diferencia: los pagas en tu link y sale solo.` : "No pagas nada."}`
  const nuevoNum = String(Math.max(...pedidosDe(rubro).map((x) => Number(x.id))) + 1).padStart(
    4,
    "0",
  )
  return (
    <Hoja
      open
      onClose={onClose}
      title={`Cambio o devolución · ${p.id}`}
      description="El pedido entregado no se toca: el cambio va en un pedido nuevo, enlazado a este."
      submitLabel={que === "cambio" ? `Crear el cambio ${nuevoNum}` : "Anotar la devolución"}
      onSubmit={(e) => {
        e.preventDefault()
        if (que === "cambio") {
          const n: Pedido = {
            ...structuredClone(p),
            id: nuevoNum,
            creado: "Hoy · ahora",
            origen: { k: "equipo", quien: "Lucía" },
            lineas: [
              { ...sale, id: nuevoId("l") },
              { ...l, id: nuevoId("l"), vuelve: true },
            ],
            entrega: {
              ...p.entrega,
              envio,
              dia: "Vie 28",
              franja: "2 a 6 p. m.",
              repartidor: p.entrega.repartidor ?? "Kevin",
            },
            cobro: "link",
            paso: cobrar ? "por_pagar" : "pagado",
            separadoHasta: cobrar ? "Vie 28 · 11:00 a. m." : undefined,
            pagos: [],
            eventos: [
              {
                id: nuevoId("e"),
                cuando: "Hoy · ahora",
                actor: "persona",
                quien: "Lucía",
                texto: `Creó el cambio del ${p.id}: vuelve la ${tallaVieja} (${por?.toLowerCase()}), sale ${queSale}.${cobrar ? ` Hay ${money(cobrar)} por cobrar: Sofi le manda su link.` : ""} Kevin recoge una y lleva la otra en el mismo viaje.`,
                paso: "por_pagar",
              },
            ],
            avisos: [],
            chat: [],
            cambioDe: p.id,
            cambioPide: undefined,
            toca: undefined,
            unoPorCiento: false,
            estrella: false,
          }
          if (sofi)
            n.avisos.push({
              id: nuevoId("a"),
              cuando: "Hoy · ahora",
              clave: "cambio",
              estado: "enviado",
              texto: avisoCambio,
            })
          if (sofi && cobrar)
            n.eventos.push({
              id: nuevoId("e"),
              cuando: "Hoy · ahora",
              actor: "sofi",
              quien: "Sofi",
              texto: `Le mandó su link a ${nombre} por los ${money(cobrar)}. Cuando pague, sale solo.`,
            })
          agregar(rubro, n)
          mover(
            rubro,
            p.id,
            (x) => {
              x.cambioEn = nuevoNum
              x.toca = undefined
            },
            {
              actor: "persona",
              quien: "Lucía",
              texto: `Cambio en el ${nuevoNum}. Este pedido no cambia: su total y su pago siguen siendo verdad.`,
            },
          )
          toast.success(`Creado el ${nuevoNum}, enlazado al ${p.id}.`)
        } else {
          mover(
            rubro,
            p.id,
            (x) => {
              x.toca = undefined
            },
            {
              actor: "persona",
              quien: "Rosa",
              texto: `Anotó una devolución de ${money(l.precio)} por Plin (${por?.toLowerCase()}). Reportes deja de contarlo como vendido.`,
            },
          )
          toast.success("Devolución anotada. Caja la muestra con su medio.")
        }
        onClose()
      }}
    >
      <Campo label="¿Qué vuelve?">
        {() => (
          <div className="flex items-center gap-3 rounded-xl border p-3 text-sm">
            <Checkbox checked aria-label={`${l.nombre} ${l.variante}`} />
            {l.foto ? (
              <img src={foto(l.foto)} alt="" className="size-10 rounded-lg object-cover" />
            ) : null}
            <span className="min-w-0 flex-1">
              <b>{l.nombre}</b> · {l.variante}
            </span>
            <span className="tabular-nums">{money(l.precio)}</span>
          </div>
        )}
      </Campo>
      <Campo label="¿Por qué?">
        {(id) => (
          <RadioChips
            aria-labelledby={id}
            value={por}
            options={["Le quedó chica", "Le quedó grande", "No le gustó", "Llegó fallado"].map(
              (o) => ({ value: o, label: o }),
            )}
            onChange={setPor}
          />
        )}
      </Campo>
      <Campo label="¿Qué se lleva?">
        {(id) => (
          <RadioChips
            aria-labelledby={id}
            value={que}
            options={[
              { value: "cambio", label: pide ? "Lo que pidió" : "Otra talla" },
              { value: "devolucion", label: "Nada: es una devolución" },
            ]}
            onChange={setQue}
          />
        )}
      </Campo>
      {que === "cambio" && pide ? (
        <Campo label="Lo que pidió" help="Lo pidió en el chat con Sofi. Hay stock.">
          {() => (
            <div className="flex items-center gap-3 rounded-xl border p-3 text-sm">
              {pide.foto ? (
                <img src={foto(pide.foto)} alt="" className="size-10 rounded-lg object-cover" />
              ) : null}
              <span className="min-w-0 flex-1">
                <b>{pide.nombre}</b> · {pide.variante}
              </span>
              <span className="tabular-nums">{money(pide.precio)}</span>
            </div>
          )}
        </Campo>
      ) : null}
      {que === "cambio" && !pide && prod && prod.sizes.length > 1 ? (
        <Campo label="La talla nueva" help={`De la ${talla} quedan 3.`}>
          {(id) => (
            <RadioChips
              aria-labelledby={id}
              value={talla}
              options={prod.sizes.slice(0, 7).map((s) => ({ value: s, label: s }))}
              onChange={setTalla}
            />
          )}
        </Campo>
      ) : null}
      {que === "cambio" ? (
        <>
          <Campo
            label="El envío del cambio lo paga"
            help={`${p.entrega.repartidor ?? "Kevin"} recoge la que vuelve y lleva la nueva en el mismo viaje.`}
          >
            {(id) => (
              <RadioChips
                aria-labelledby={id}
                value={paga}
                options={["La tienda", nombre].map((o) => ({ value: o, label: o }))}
                onChange={setPaga}
              />
            )}
          </Campo>
          <Resumen
            rows={[
              ["Vuelve", `− ${money(l.precio)}`],
              ["Sale", money(sale.precio)],
              ["Envío del cambio", envio ? money(envio) : "Gratis"],
              cobrar
                ? ["Falta cobrar · Sofi le manda su link", money(cobrar), "falta"]
                : dif < 0
                  ? ["A su favor", money(-dif), "favor"]
                  : ["Falta cobrar", "Nada", "ok"],
            ]}
          />
          <SofiAvisa on={sofi} set={setSofi} texto={`«${avisoCambio}»`} />
        </>
      ) : (
        <p className="rounded-xl border p-3 text-sm">
          Devuelves <b>{money(l.precio)}</b> desde tu app de Plin. gestorIA no mueve el dinero:
          anota lo que devolviste, con su medio y quién lo hizo.
        </p>
      )}
    </Hoja>
  )
}

/* ---------- Entregado y cobrado (desde la tienda) ---------- */

function Cobrar({ p, onClose }: { p: Pedido; onClose: () => void }) {
  const { rubro } = useRuta()
  const k = cuentas(p)
  const [medio, setMedio] = useState<string | null>("efectivo")
  const [monto, setMonto] = useState(String(k.falta))
  const necesitaFoto = medio === "pos"
  return (
    <Hoja
      open
      onClose={onClose}
      title={k.falta > 0 ? "Entregado y cobrado" : "Entregado"}
      description={`Pedido ${p.id} · ${p.clienta}`}
      submitLabel={k.falta > 0 ? `Cobré ${money(Number(monto) || 0)} y entregué` : "Entregado"}
      onSubmit={(e) => {
        e.preventDefault()
        mover(
          rubro,
          p.id,
          (x) => {
            if (k.falta > 0)
              x.pagos.push({
                id: nuevoId("pg"),
                medio: (medio ?? "efectivo") as Medio,
                monto: Number(monto) || 0,
                estado: "confirmado",
                cuando: "Hoy · ahora",
                quien: p.entrega.repartidor ?? "Rosa",
              })
            x.paso = "entregado"
            avisar(
              x,
              "entregado",
              `${p.entrega.repartidor ?? "Te"} dejó tu pedido. ¿Te llegó bien?`,
            )
          },
          {
            actor: "persona",
            quien: "Rosa",
            texto: `${k.falta > 0 ? `Anotó ${money(Number(monto) || 0)} en ${medio} y ` : ""}lo marcó entregado (también «Salió»).`,
            paso: "entregado",
          },
        )
        toast.success("Entregado.")
        onClose()
      }}
    >
      {k.falta > 0 ? (
        <>
          <Campo label="¿Cuánto cobraste?">
            {(id) => (
              <Input
                aria-labelledby={id}
                inputMode="decimal"
                value={monto}
                onChange={(e) => setMonto(e.target.value)}
                className="max-w-40"
              />
            )}
          </Campo>
          <Campo
            label="Con qué"
            help={
              necesitaFoto
                ? "El repartidor sube la foto del voucher desde su app."
                : medio === "yape"
                  ? "Yape a tu número: confírmalo con la captura antes de entregar."
                  : undefined
            }
          >
            {(id) => (
              <RadioChips
                aria-labelledby={id}
                value={medio}
                options={[
                  { value: "efectivo", label: "Efectivo" },
                  { value: "pos", label: "POS" },
                  { value: "yape", label: "Yape a la tienda" },
                ]}
                onChange={setMedio}
              />
            )}
          </Campo>
        </>
      ) : (
        <p className="text-sm">Está pagado: queda «Entregado» y, si no estaba, también «Salió».</p>
      )}
    </Hoja>
  )
}

/* ---------- Anotar un pedido a mano ---------- */

export function Anotar({ onClose }: { onClose: () => void }) {
  const { rubro } = useRuta()
  const R = RUBROS[rubro]
  const P = R.products()
  const [nombre, setNombre] = useState("")
  const [tel, setTel] = useState("")
  const [canal, setCanal] = useState<string | null>("instagram")
  const [pid, setPid] = useState<string | null>(P[0]?.id ?? null)
  const [zona, setZona] = useState<string | null>("Surco")
  const [cobro, setCobro] = useState<string | null>("link")
  const [err, setErr] = useState<string | null>(null)
  const prod = P.find((x) => x.id === pid)
  return (
    <Hoja
      open
      onClose={onClose}
      title="Anotar un pedido"
      description="Para lo que vendiste tú, en persona o desde el celular de la tienda."
      submitLabel={cobro === "link" ? "Anotar y mandar el link" : "Anotar"}
      isDirty={!!nombre}
      error={err}
      onSubmit={(e) => {
        e.preventDefault()
        if (!nombre.trim()) return setErr("Escribe el nombre de la clienta.")
        const num = String(Math.max(...pedidosDe(rubro).map((x) => Number(x.id))) + 1).padStart(
          4,
          "0",
        )
        const env = DISTRITOS.find(([d]) => d === zona)?.[1] ?? 10
        const c = prod?.colors[0]
        const m = prod?.media.find((x) => x.kind === "foto") ?? prod?.media[0]
        agregar(rubro, {
          id: num,
          clienta: nombre.trim(),
          telefono: tel || "—",
          canal: (canal === "en_persona" ? "whatsapp" : canal) as Pedido["canal"],
          origen: { k: "equipo", quien: "Lucía" },
          paso: cobro === "al_recibir" ? "preparando" : "por_pagar",
          creado: "Hoy · ahora",
          lineas: prod
            ? [
                {
                  id: nuevoId("l"),
                  pid: prod.id,
                  nombre: prod.name,
                  variante: [c?.name, prod.sizes[2]].filter(Boolean).join(" · "),
                  qty: 1,
                  precio: prod.list,
                  foto: m ? (m.kind === "video" ? (m.poster ?? "") : m.src) : "",
                },
              ]
            : [],
          entrega: {
            tipo: "moto",
            zona: zona ?? "Surco",
            envio: env,
            dia: "Vie 28",
            franja: null,
            repartidor: null,
            direccion: "La pide Sofi al mandar el link",
          },
          cobro: (cobro ?? "link") as Pedido["cobro"],
          pagos: [],
          separadoHasta: cobro === "link" ? "Vie 28 · 10:15 a. m." : undefined,
          eventos: [
            {
              id: nuevoId("e"),
              cuando: "Hoy · ahora",
              actor: "persona",
              quien: "Lucía",
              texto: `Anotó el pedido a mano${cobro === "link" ? ". Sofi le mandó su carrito con «Pagar ahora»." : "."}`,
              paso: "por_pagar",
            },
          ],
          avisos:
            cobro === "link"
              ? [
                  {
                    id: nuevoId("a"),
                    cuando: "Hoy · ahora",
                    clave: "link",
                    estado: "enviado",
                    texto: `Hola ${nombre.split(" ")[0]}, aquí está tu pedido de ${R.store.name}. Lo pagas en este link.`,
                  },
                ]
              : [],
          chat: [],
          unoPorCiento: false,
        })
        toast.success(`Anotado el ${num}.`)
        onClose()
      }}
    >
      <Campo label="Clienta">
        {(id) => (
          <Input
            aria-labelledby={id}
            value={nombre}
            onChange={(e) => (setNombre(e.target.value), setErr(null))}
            placeholder="Nombre y apellido"
            aria-invalid={!!err && !nombre}
          />
        )}
      </Campo>
      <Campo label="Su WhatsApp" help="Si ya compró, se completa lo demás.">
        {(id) => (
          <Input
            aria-labelledby={id}
            inputMode="tel"
            value={tel}
            onChange={(e) => setTel(e.target.value)}
            placeholder="987 654 321"
          />
        )}
      </Campo>
      <Campo label="¿Por dónde lo pidió?">
        {(id) => (
          <RadioChips
            aria-labelledby={id}
            value={canal}
            options={[
              { value: "whatsapp", label: "WhatsApp" },
              { value: "instagram", label: "Instagram" },
              { value: "messenger", label: "Messenger" },
              { value: "en_persona", label: "En persona" },
            ]}
            onChange={setCanal}
          />
        )}
      </Campo>
      <Campo label="Qué lleva">
        {(id) => (
          <RadioChips
            aria-labelledby={id}
            value={pid}
            options={P.slice(0, 4).map((x) => ({ value: x.id, label: x.name }))}
            onChange={setPid}
          />
        )}
      </Campo>
      <Campo label="Zona">
        {(id) => (
          <RadioChips
            aria-labelledby={id}
            value={zona}
            options={DISTRITOS.slice(0, 4).map(([d, c]) => ({
              value: d,
              label: `${d} · ${money(c)}`,
            }))}
            onChange={setZona}
          />
        )}
      </Campo>
      <Campo
        label="Cómo paga"
        help={
          cobro === "link"
            ? "Sofi le manda su carrito con «Pagar ahora» y le pide la dirección. El pago se confirma solo."
            : cobro === "al_recibir"
              ? "Lo cobra el repartidor en la puerta."
              : "Te manda la captura y la confirmas tú."
        }
      >
        {(id) => (
          <RadioChips
            aria-labelledby={id}
            value={cobro}
            options={[
              { value: "link", label: "Link de pago" },
              { value: "captura", label: "Yape o Plin a la tienda" },
              { value: "al_recibir", label: "Al recibir" },
            ]}
            onChange={setCobro}
          />
        )}
      </Campo>
      <p className="flex items-center gap-2 rounded-xl bg-muted px-3 py-2 text-xs text-muted-foreground">
        <Link2 className="size-3.5" aria-hidden />
        Lo vendió tu equipo: no cuenta para el 1 % de gestorIA.
      </p>
    </Hoja>
  )
}

/* ---------- Deshacer un pago y anular ---------- */

export function Deshacer({
  p,
  pagoId,
  onClose,
}: {
  p: Pedido
  pagoId: string
  onClose: () => void
}) {
  const { rubro } = useRuta()
  const [m, setM] = useState("")
  const [err, setErr] = useState<string | null>(null)
  const g = p.pagos.find((x) => x.id === pagoId)
  if (!g) return null
  return (
    <Hoja
      open
      dock={false}
      onClose={onClose}
      title="Deshacer la confirmación"
      description={`${MEDIOCORTO[g.medio]} de ${money(g.monto)} · Pedido ${p.id}`}
      submitLabel="Deshacer"
      error={err}
      isDirty={!!m}
      onSubmit={(e) => {
        e.preventDefault()
        if (!m.trim()) return setErr("Escribe el motivo: queda en la historia.")
        mover(
          rubro,
          p.id,
          (x) => {
            const y = x.pagos.find((z) => z.id === pagoId)!
            y.estado = "por_confirmar"
            y.motivo = m
            x.paso = "por_confirmar"
            x.toca = {
              texto: `Deshiciste el ${MEDIOCORTO[g.medio]} de ${money(g.monto)}: revísalo otra vez.`,
              boton: "Ver y confirmar",
              accion: "confirmar",
            }
          },
          {
            actor: "persona",
            quien: "Rosa",
            texto: `Deshizo la confirmación del ${MEDIOCORTO[g.medio]} de ${money(g.monto)}: «${m}».`,
            paso: "por_confirmar",
          },
        )
        onClose()
      }}
    >
      <Campo label="¿Por qué?">
        {(id) => (
          <Textarea
            aria-labelledby={id}
            value={m}
            onChange={(e) => (setM(e.target.value), setErr(null))}
            placeholder="Ej.: lo confirmé en el pedido equivocado"
          />
        )}
      </Campo>
      <p className="text-sm text-muted-foreground">
        El pago vuelve a «por confirmar». No se borra nada: queda en la historia con tu motivo.
      </p>
    </Hoja>
  )
}

function Anular({ p, onClose }: { p: Pedido; onClose: () => void }) {
  const { rubro } = useRuta()
  const [m, setM] = useState<string | null>(null)
  const [err, setErr] = useState<string | null>(null)
  return (
    <Hoja
      open
      dock={false}
      onClose={onClose}
      title={`Anular el pedido ${p.id}`}
      description="Lo separado vuelve al stock. Si tenía un pago, se devuelve con su medio."
      submitLabel="Anular"
      error={err}
      onSubmit={(e) => {
        e.preventDefault()
        if (!m) return setErr("Elige el motivo.")
        mover(rubro, p.id, (x) => ((x.paso = "anulado"), (x.toca = undefined)), {
          actor: "persona",
          quien: "Rosa",
          texto: `Anuló el pedido: ${m.toLowerCase()}. Lo separado volvió al stock.`,
          paso: "anulado",
        })
        onClose()
      }}
    >
      <Campo label="¿Por qué?">
        {(id) => (
          <RadioChips
            aria-labelledby={id}
            value={m}
            invalid={!!err}
            options={["Ya no lo quiere", "Pedido repetido", "Sin stock", "Otro"].map((o) => ({
              value: o,
              label: o,
            }))}
            onChange={(v) => (setM(v), setErr(null))}
          />
        )}
      </Campo>
    </Hoja>
  )
}

/** Mandar el link otra vez: se abre el WhatsApp con el texto (en la app, sale por la Bandeja). */
function MandarLink({ p, onClose }: { p: Pedido; onClose: () => void }) {
  const { rubro } = useRuta()
  const R = RUBROS[rubro]
  return (
    <Hoja
      open
      onClose={onClose}
      title="Recordarle el link"
      description={`Pedido ${p.id} · ${p.clienta}`}
      submitLabel="Que Sofi se lo recuerde"
      onSubmit={(e) => {
        e.preventDefault()
        mover(
          rubro,
          p.id,
          (x) =>
            avisar(
              x,
              "link",
              `Hola ${p.clienta.split(" ")[0]}, tu carrito sigue separado hasta ${p.separadoHasta?.split("· ")[1] ?? "hoy"}. Lo pagas aquí: ${R.store.slug}.gestoria24.com/carrito/V8R2`,
            ),
          { actor: "sofi", quien: "Sofi", texto: "Le recordó el link, por pedido de Rosa." },
        )
        toast.success("Sofi se lo recordó.")
        onClose()
      }}
    >
      <div className="flex items-start gap-2 rounded-xl border p-3 text-sm">
        <AgentMark className="mt-0.5" />
        <span>
          «Hola {p.clienta.split(" ")[0]}, tu carrito sigue separado hasta{" "}
          {p.separadoHasta?.split("· ")[1] ?? "hoy"}. Lo pagas aquí: {R.store.slug}
          .gestoria24.com/carrito/V8R2»
        </span>
      </div>
      <p className="text-sm text-muted-foreground">
        Sofi ya se lo recuerda sola una vez, 3 horas antes de que venza. Este es uno más.
      </p>
    </Hoja>
  )
}

/** El cajón de cada acción. Una sola a la vez. */
export function AccionDrawer({
  p,
  accion,
  pagoId,
  onClose,
}: {
  p: Pedido
  accion: Accion | "deshacer"
  pagoId?: string
  onClose: () => void
}) {
  switch (accion) {
    case "confirmar":
      return <ConfirmarPago p={p} onClose={onClose} />
    case "pasar":
      return <PasarA p={p} onClose={onClose} />
    case "asignar":
      return <PasarA p={p} onClose={onClose} asignar />
    case "cambiar":
      return <Cambiar p={p} onClose={onClose} />
    case "no_entregado":
      return <NoEntregado p={p} onClose={onClose} />
    case "cambio":
      return <CambioDevolucion p={p} onClose={onClose} />
    case "cobrar":
      return <Cobrar p={p} onClose={onClose} />
    case "anular":
      return <Anular p={p} onClose={onClose} />
    case "link":
      return <MandarLink p={p} onClose={onClose} />
    case "revisar":
      return <RevisarDrawer p={p} onClose={onClose} />
    case "excepcion":
      return <ExcepcionDrawer p={p} onClose={onClose} />
    case "deshacer":
      return pagoId ? <Deshacer p={p} pagoId={pagoId} onClose={onClose} /> : null
    default:
      return null
  }
}

import { Badge, Button, cn, Input, toast, useIsMobile } from "@odentia/ui"
import { PageHeader, PageShell } from "@odentia/ui-patterns"
import {
  ArrowLeft,
  Banknote,
  Camera,
  Check,
  CreditCard,
  Lock,
  MapPin,
  Phone,
  QrCode,
  Smartphone,
  X,
} from "lucide-react"
import { RadioChips } from "@odentia/ui-patterns"
import { createContext, type ReactNode, useContext, useState } from "react"
import { foto, RUBROS } from "../datos"
import { ir, useRuta } from "../ruta"
import { PhoneFrame } from "../vitrina/marcos"
import {
  avisar,
  cuentas,
  type Medio,
  money,
  mover,
  nuevoId,
  type Pedido,
  usePedidos,
} from "./modelo"
import { cobroDe, MOTIVOS_NO, noRecibio, vueltoDe } from "./cobros"
import { recogido } from "./vuelta"

type Forma = "link" | "efectivo" | "yape" | "pos"

/**
 * Ningún botón del repartidor actúa en un toque: «Salí», «Cobrar», «Entregado», «Recogí» y «No
 * estaba» abren una hoja que dice a quién, qué y cuánto, y ahí se confirma. Así no hay toques por
 * error con el celular en la mano.
 */
interface Conf {
  titulo: string
  filas: [string, ReactNode][]
  boton: string
  hacer: (motivo?: string) => void
  peligro?: boolean
  /** Si hay que decir por qué: «No se entregó» pide el motivo, y cada motivo dice qué pasa. */
  motivos?: { valor: string; pasa: string }[]
}
const Confirma = createContext<(c: Conf) => void>(() => {})

function HojaConfirmar({ c, onClose }: { c: Conf; onClose: () => void }) {
  const [motivo, setMotivo] = useState<string | null>(null)
  const pasa = c.motivos?.find((m) => m.valor === motivo)?.pasa
  return (
    <div className="absolute inset-0 z-30 flex flex-col justify-end bg-black/40" role="presentation" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={c.titulo}
        className="flex flex-col gap-3 rounded-t-2xl bg-background p-4 pb-5 shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        <span className="mx-auto h-1.5 w-10 rounded-full bg-muted" aria-hidden />
        <b className="text-[17px]">{c.titulo}</b>
        <dl className="flex flex-col divide-y rounded-xl border text-sm">
          {c.filas.map(([k, v]) => (
            <div key={k} className="flex items-start justify-between gap-3 px-3 py-2.5">
              <dt className="shrink-0 text-muted-foreground">{k}</dt>
              <dd className="min-w-0 text-right font-medium">{v}</dd>
            </div>
          ))}
          {pasa ? (
            <div className="flex items-start justify-between gap-3 px-3 py-2.5">
              <dt className="shrink-0 text-muted-foreground">Qué pasa</dt>
              <dd className="min-w-0 text-right font-medium">{pasa}</dd>
            </div>
          ) : null}
        </dl>
        {c.motivos ? (
          <>
            <span id="motivo-no" className="text-xs font-medium">
              ¿Qué pasó?
            </span>
            <RadioChips
              aria-labelledby="motivo-no"
              value={motivo ?? ""}
              options={c.motivos.map((m) => ({ value: m.valor, label: m.valor }))}
              onChange={setMotivo}
            />
          </>
        ) : null}
        <div className="flex gap-2">
          <Button variant="outline" className="h-12 flex-1" onClick={onClose}>
            Volver
          </Button>
          <Button
            variant={c.peligro ? "destructive" : "default"}
            className="h-12 flex-[2] whitespace-nowrap"
            disabled={!!c.motivos && !motivo}
            onClick={() => {
              c.hacer(motivo ?? undefined)
              onClose()
            }}
          >
            {c.boton}
          </Button>
        </div>
      </div>
    </div>
  )
}

const nombreCorto = (p: Pedido) => `${p.clienta.split(" ")[0]} ${p.clienta.split(" ")[1]?.[0] ?? ""}.`
const loQueLleva = (p: Pedido) =>
  p.lineas
    .filter((l) => !l.vuelve)
    .map((l) => `${l.nombre} · ${l.variante}`)
    .join(", ")

/** Cobrar en la puerta: cada forma con quien la confirma. «Entregué» solo con el pago confirmado. */
function Cobrar({ p, onClose }: { p: Pedido; onClose: () => void }) {
  const { rubro } = useRuta()
  const confirmar = useContext(Confirma)
  const k = cuentas(p)
  const [forma, setForma] = useState<Forma | null>(null)
  const [recibi, setRecibi] = useState(p.pagaCon && vueltoDe(p) ? String(p.pagaCon) : "")
  const [foto, setFoto] = useState(false)
  const esperaTienda = p.pagos.some((x) => x.estado === "por_confirmar")
  const confirmado = k.falta === 0 && k.porConfirmar === 0
  const n = p.clienta.split(" ")[0]
  const cobrar = (medio: Medio, quien: string, texto: string) =>
    mover(
      rubro,
      p.id,
      (x) => {
        x.pagos.push({
          id: nuevoId("pg"),
          medio,
          monto: cuentas(x).falta,
          estado: "confirmado",
          cuando: "Hoy · ahora",
          quien,
        })
      },
      {
        actor: medio === "link" ? "pasarela" : "repartidor",
        quien: medio === "link" ? "La pasarela" : "Kevin",
        texto,
      },
    )
  return (
    <div
      className="absolute inset-0 z-20 flex flex-col bg-background"
      role="dialog"
      aria-label={`Cobrar ${p.id}`}
    >
      <div className="flex items-center gap-2 border-b px-4 py-3">
        <span className="flex-1">
          <b className="block text-[15px]">Cobrar · {p.id}</b>
          <span className="text-xs text-muted-foreground">
            {n} · {RUBROS[rubro].store.name}
          </span>
        </span>
        <Button variant="ghost" size="icon-sm" aria-label="Cerrar" onClick={onClose}>
          <X aria-hidden />
        </Button>
      </div>
      <div className="flex flex-1 flex-col gap-3 overflow-y-auto p-4">
        <p className="text-center">
          <span className="text-xs text-muted-foreground">
            {confirmado ? "Cobrado" : "Total a cobrar"}
          </span>
          <b className="block font-heading text-4xl tabular-nums">
            {money(confirmado ? k.confirmado : k.falta)}
          </b>
          {k.confirmado && !confirmado ? (
            <span className="text-xs text-muted-foreground">
              Ya pagó {money(k.confirmado)} antes
            </span>
          ) : null}
          {vueltoDe(p) && !confirmado ? (
            <span className="mt-1 block rounded-lg bg-warning-soft px-2 py-1 text-sm font-medium">
              Paga con {money(p.pagaCon!)}: lleva vuelto de {money(vueltoDe(p))}
            </span>
          ) : null}
        </p>
        {confirmado ? (
          <p className="flex items-center justify-center gap-2 rounded-xl bg-success-soft p-3 text-sm font-semibold text-success">
            <Check className="size-4" aria-hidden />
            Pago confirmado
          </p>
        ) : esperaTienda ? (
          <div className="flex flex-col gap-2 rounded-xl bg-warning-soft p-3 text-sm">
            <b>Esperando a la tienda</b>
            La tienda está revisando el Yape en su app. Recién cuando lo confirme puedes entregar.
            <Button
              size="sm"
              variant="outline"
              className="propuesta self-start"
              onClick={() =>
                mover(
                  rubro,
                  p.id,
                  (x) => {
                    const g = x.pagos.find((y) => y.estado === "por_confirmar")
                    if (g) (g.estado = "confirmado"), (g.quien = "Lucía")
                    x.toca = undefined
                  },
                  {
                    actor: "persona",
                    quien: "Lucía",
                    texto: "Confirmó el Yape en la puerta: Kevin ya puede entregar.",
                  },
                )
              }
            >
              Prototipo: Lucía lo confirma
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2" role="radiogroup" aria-label="Cómo paga">
            {(
              [
                [
                  "link",
                  "Con su link: Yape o tarjeta",
                  "Escanea el código con su celular. Se confirma solo.",
                  QrCode,
                ],
                ["efectivo", "Efectivo", "Lo confirmas tú al recibirlo.", Banknote],
                [
                  "pos",
                  "Tarjeta, con el POS de la tienda",
                  "Toma la foto del voucher aprobado.",
                  CreditCard,
                ],
                [
                  "yape",
                  "Yape o Plin al número de la tienda",
                  "Toma la foto de su captura. La confirma la tienda.",
                  Smartphone,
                ],
              ] as const
            ).map(([v, l, d, I]) => (
              <button
                key={v}
                type="button"
                role="radio"
                aria-checked={forma === v}
                onClick={() => (setForma(v), setFoto(false))}
                className={cn(
                  "flex items-start gap-3 rounded-xl border bg-card p-3 text-left",
                  forma === v && "border-primary ring-1 ring-primary",
                )}
              >
                <I className="mt-0.5 size-5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="text-sm">
                  <b className="block">{l}</b>
                  <span className="text-muted-foreground">{d}</span>
                </span>
              </button>
            ))}
          </div>
        )}
        {!confirmado && !esperaTienda && forma === "link" ? (
          <div className="flex flex-col items-center gap-2 rounded-xl border p-4">
            <QrCode className="size-24" aria-hidden />
            <span className="text-xs text-muted-foreground">El código del mismo link de {n}</span>
            <Button
              size="sm"
              variant="outline"
              className="propuesta"
              onClick={() =>
                cobrar(
                  "link",
                  "la pasarela",
                  `${n} pagó con el código en la puerta. Lo confirmó la pasarela, sola.`,
                )
              }
            >
              Prototipo: {n} paga
            </Button>
          </div>
        ) : null}
        {!confirmado && !esperaTienda && forma === "efectivo" ? (
          <div className="flex flex-col gap-2 rounded-xl border p-3 text-sm">
            <label className="flex items-center gap-2">
              Recibí S/
              <Input
                inputMode="decimal"
                value={recibi}
                onChange={(e) => setRecibi(e.target.value)}
                className="h-9 w-24"
                placeholder={String(k.falta)}
              />
              {Number(recibi) > k.falta ? (
                <span className="text-muted-foreground">
                  vuelto {money(Number(recibi) - k.falta)}
                </span>
              ) : null}
            </label>
            <Button
              onClick={() =>
                confirmar({
                  titulo: "¿Recibiste el efectivo?",
                  filas: [
                    ["A quién", `${nombreCorto(p)} · ${p.id}`],
                    ["Qué", "Efectivo, en la puerta"],
                    ["Cuánto", money(k.falta)],
                    ...(Number(recibi) > k.falta
                      ? ([["Vuelto", money(Number(recibi) - k.falta)]] as [string, string][])
                      : []),
                  ],
                  boton: `Sí, recibí ${money(k.falta)}`,
                  hacer: () =>
                    cobrar("efectivo", "Kevin", `Cobró ${money(k.falta)} en efectivo. Lo entrega en Caja.`),
                })
              }
            >
              Recibí {money(k.falta)}
            </Button>
          </div>
        ) : null}
        {!confirmado && !esperaTienda && (forma === "pos" || forma === "yape") ? (
          <div className="flex flex-col gap-2 rounded-xl border p-3 text-sm">
            {foto ? (
              <span className="flex items-center gap-2 rounded-lg bg-muted p-2">
                <Camera className="size-4" aria-hidden />
                {forma === "pos" ? "Foto del voucher" : "Foto de la captura"} · lista
              </span>
            ) : (
              <Button variant="outline" onClick={() => setFoto(true)}>
                <Camera aria-hidden />
                {forma === "pos" ? "Tomar foto del voucher" : "Tomar foto de la captura"}
              </Button>
            )}
            <Button
              disabled={!foto}
              onClick={() =>
                confirmar({
                  titulo: forma === "pos" ? "¿El voucher dice aprobado?" : "¿Mandas la captura a la tienda?",
                  filas: [
                    ["A quién", `${nombreCorto(p)} · ${p.id}`],
                    ["Qué", forma === "pos" ? "Tarjeta, con el POS · foto del voucher" : "Yape o Plin · foto de la captura"],
                    ["Cuánto", money(k.falta)],
                  ],
                  boton: forma === "pos" ? `Sí, cobré ${money(k.falta)}` : "Mandar a la tienda",
                  hacer: () => {
                if (forma === "pos")
                  cobrar(
                    "pos",
                    "Kevin",
                    `Cobró ${money(k.falta)} con el POS. Subió la foto del voucher aprobado.`,
                  )
                else
                  mover(
                    rubro,
                    p.id,
                    (x) => {
                      x.pagos.push({
                        id: nuevoId("pg"),
                        medio: "yape",
                        monto: cuentas(x).falta,
                        estado: "por_confirmar",
                        cuando: "Hoy · ahora",
                        captura: {
                          monto: cuentas(x).falta,
                          nombre: `${n} ${p.clienta.split(" ")[1]?.[0] ?? ""}.`,
                          hora: "ahora",
                        },
                      })
                      x.toca = {
                        texto: `Kevin está en la puerta de ${n}: yapeó ${money(cuentas(x).falta)} al número de la tienda.`,
                        boton: "Ver y confirmar",
                        accion: "confirmar",
                        urgente: true,
                      }
                    },
                    {
                      actor: "repartidor",
                      quien: "Kevin",
                      texto: `Subió la foto del Yape de ${n} en la puerta. Espera que la tienda lo confirme.`,
                    },
                  )
                  },
                })
              }
            >
              {forma === "pos" ? "Voucher aprobado" : "Mandar a la tienda"}
            </Button>
          </div>
        ) : null}
      </div>
      <div className="border-t p-4">
        <Button
          className="h-12 w-full text-[15px]"
          disabled={!confirmado}
          onClick={() =>
            confirmar({
              titulo: "¿Lo entregaste?",
              filas: [
                ["A quién", `${nombreCorto(p)} · ${p.id}`],
                ["Dónde", p.entrega.direccion],
                ["Qué", loQueLleva(p)],
                ["Cuánto", k.confirmado ? `${money(k.confirmado)} · pagado` : "Pagado"],
              ],
              boton: "Sí, entregado",
              hacer: () => {
            mover(
              rubro,
              p.id,
              (x) => {
                x.paso = "entregado"
                avisar(x, "entregado", `Kevin dejó tu pedido. ¿Te llegó bien?`)
              },
              {
                actor: "repartidor",
                quien: "Kevin",
                texto: "Tocó «Entregado».",
                paso: "entregado",
              },
            )
            toast.success(`${p.id} entregado.`)
            onClose()
              },
            })
          }
        >
          {confirmado ? (
            k.confirmado ? (
              `Entregado`
            ) : (
              "Entregado"
            )
          ) : (
            <>
              <Lock aria-hidden />
              Entregado: primero el pago confirmado
            </>
          )}
        </Button>
      </div>
    </div>
  )
}

function Entrega({ p, onCobrar }: { p: Pedido; onCobrar: () => void }) {
  const { rubro } = useRuta()
  const confirmar = useContext(Confirma)
  const k = cuentas(p)
  const pagado = k.falta === 0 && k.porConfirmar === 0
  const n = `${p.clienta.split(" ")[0]} ${p.clienta.split(" ")[1]?.[0] ?? ""}.`
  return (
    <li
      className={cn(
        "flex flex-col gap-2 rounded-xl border bg-card p-3",
        p.paso === "entregado" && "opacity-60",
      )}
    >
      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <b className="block text-sm">
            {p.id} · {n}
          </b>
          <span className="flex items-start gap-1 text-xs text-muted-foreground">
            <MapPin className="mt-0.5 size-3 shrink-0" aria-hidden />
            {p.entrega.direccion}
          </span>
        </span>
        {p.rechazo ? (
          <Badge variant="destructive">Vuelve a la tienda</Badge>
        ) : p.paso === "entregado" ? (
          <Badge variant="success">Entregado</Badge>
        ) : pagado ? (
          <Badge variant="success">Pagado</Badge>
        ) : (
          <Badge variant="warning">Cobrar {money(k.falta || k.porConfirmar)}</Badge>
        )}
      </span>
      {vueltoDe(p) && !p.rechazo ? (
        <span className="flex items-center gap-1.5 rounded-lg bg-warning-soft px-2 py-1 text-xs font-medium">
          <Banknote className="size-3.5" aria-hidden />
          Lleva vuelto de {money(vueltoDe(p))} · paga con {money(p.pagaCon!)}
        </span>
      ) : null}
      {p.rechazo ? (
        <span className="rounded-lg bg-destructive/10 px-2 py-1 text-xs">
          {p.rechazo.motivo}. Tráelo de vuelta a la tienda y entrégalo con tu plata.
        </span>
      ) : null}
      {p.cambioDe && p.lineas.some((l) => l.vuelve) ? (
        <span className="rounded-lg bg-primary-soft px-2 py-1 text-xs text-primary-soft-foreground">
          Lleva {p.lineas.find((l) => !l.vuelve)?.variante} · recoge{" "}
          {p.lineas.find((l) => l.vuelve)?.variante}, con su foto
        </span>
      ) : null}
      {p.paso === "en_camino" && !p.rechazo ? (
        <span className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" aria-label={`Llamar a ${n}`}>
            <Phone aria-hidden />
          </Button>
          <Button size="sm" className="flex-1" onClick={onCobrar}>
            {pagado ? "Entregado" : "Cobrar y entregar"}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() =>
              confirmar({
                titulo: "¿No se entregó?",
                filas: [
                  ["A quién", `${nombreCorto(p)} · ${p.id}`],
                  ["Dónde", p.entrega.direccion],
                ],
                motivos: MOTIVOS_NO.map((m) => ({
                  valor: m,
                  pasa:
                    m === MOTIVOS_NO[0]
                      ? "Vuelve contigo. Sofi le escribe para llevárselo mañana."
                      : `Lo traes de vuelta a la tienda. Sofi le pregunta si lo quiere otro día; ${cobroDe(rubro).viaje === "clienta" ? `el viaje (${money(p.entrega.envio)}) va a su saldo, como dice la política` : "el viaje lo paga la tienda"}.`,
                })),
                boton: "Sí, no se entregó",
                peligro: true,
                hacer: (motivo) => {
                  if (motivo && motivo !== MOTIVOS_NO[0]) {
                    noRecibio(rubro, p, "Kevin", motivo)
                    toast.info(`${nombreCorto(p)}: vuelve a la tienda contigo.`, {
                      description: "Sofi ya le escribió. Entrégalo en la tienda con tu plata.",
                    })
                    return
                  }
                  mover(
                    rubro,
                    p.id,
                    (x) => {
                      x.paso = "por_salir"
                      x.noEntregado = "No estaba: nadie abrió."
                      x.entrega.dia = "Vie 28"
                      avisar(
                        x,
                        "falla",
                        `No te encontramos en casa, ${p.clienta.split(" ")[0]}. ¿Te lo llevamos mañana entre ${p.entrega.franja}?`,
                      )
                    },
                    {
                      actor: "repartidor",
                      quien: "Kevin",
                      texto: "«No estaba»: nadie abrió. Sofi le escribió para otro día.",
                      paso: "por_salir",
                    },
                  )
                },
              })
            }
          >
            No se entregó
          </Button>
        </span>
      ) : null}
    </li>
  )
}

const ESTADOS = ["Sin uso, con su caja", "Con uso", "Con falla"] as const

/** La tarea «Recoger»: la foto de cómo está el producto y «Recogí». Lo deja en la tienda. */
function Recoger({ p }: { p: Pedido }) {
  const { rubro } = useRuta()
  const confirmar = useContext(Confirma)
  const v = p.vuelta!
  const [abierto, setAbierto] = useState(false)
  const [foto1, setFoto] = useState(false)
  const [estado, setEstado] = useState<string | null>(v.motivo === "falla" ? "Con falla" : null)
  const n = `${p.clienta.split(" ")[0]} ${p.clienta.split(" ")[1]?.[0] ?? ""}.`
  const l = v.vuelven[0]!
  return (
    <li className="flex flex-col gap-2 rounded-xl border border-primary/40 bg-card p-3">
      <span className="flex items-start gap-2">
        <span className="min-w-0 flex-1">
          <b className="block text-sm">
            {p.id} · {n}
          </b>
          <span className="flex items-start gap-1 text-xs text-muted-foreground">
            <MapPin className="mt-0.5 size-3 shrink-0" aria-hidden />
            {p.entrega.direccion}
          </span>
        </span>
        <Badge variant="soft">Recoger</Badge>
      </span>
      <span className="flex items-center gap-2 text-xs">
        {l.foto ? <img src={foto(l.foto)} alt="" className="size-9 rounded-lg object-cover" /> : null}
        <span>
          Recoge <b>{l.nombre}</b> · {l.variante}. No cobra nada.
        </span>
      </span>
      {!abierto ? (
        <Button size="sm" onClick={() => setAbierto(true)}>
          Recoger
        </Button>
      ) : (
        <div className="flex flex-col gap-2 rounded-lg bg-muted/50 p-2">
          <Button size="sm" variant={foto1 ? "outline" : "default"} onClick={() => setFoto(true)}>
            <Camera aria-hidden />
            {foto1 ? "Foto tomada · volver a tomar" : "Tomar la foto de cómo está"}
          </Button>
          {foto1 ? (
            <span className="flex items-center gap-2 text-xs text-muted-foreground">
              {l.foto ? <img src={foto(l.foto)} alt="Foto al recoger" className="size-12 rounded-lg object-cover" /> : null}
              La foto queda en el pedido.
            </span>
          ) : null}
          <span id={`est-${p.id}`} className="text-xs font-medium">
            ¿Cómo está?
          </span>
          <RadioChips
            aria-labelledby={`est-${p.id}`}
            value={estado}
            options={ESTADOS.map((e) => ({ value: e, label: e }))}
            onChange={setEstado}
          />
          <Button
            size="sm"
            disabled={!foto1 || !estado}
            onClick={() =>
              confirmar({
                titulo: "¿Lo recogiste?",
                filas: [
                  ["A quién", `${n} · ${p.id}`],
                  ["Qué", `${l.nombre} · ${l.variante}`],
                  ["Cómo está", estado!],
                  ["Cuánto", "No cobras nada"],
                ],
                boton: "Sí, lo recogí",
                hacer: () => {
                  recogido(rubro, p, "Kevin", estado!.toLowerCase())
                  toast.success("Recogido. Lo dejas en la tienda al cerrar tu ruta.")
                },
              })
            }
          >
            <Check aria-hidden />
            Recogí
          </Button>
          {!foto1 ? (
            <span className="text-xs text-muted-foreground">«Recogí» se activa con la foto.</span>
          ) : null}
        </div>
      )}
    </li>
  )
}

/** gestorIA Reparto: la app del repartidor, para todas sus tiendas. Aquí, solo lo de este flujo. */
function App() {
  const { rubro } = useRuta()
  const R = RUBROS[rubro]
  const all = usePedidos(rubro)
  const [cobrando, setCobrando] = useState<string | null>(null)
  const [conf, setConf] = useState<Conf | null>(null)
  const mias = all.filter(
    (p) =>
      p.entrega.repartidor === "Kevin" &&
      p.entrega.dia === "Hoy" &&
      ["por_salir", "en_camino", "entregado", "preparando"].includes(p.paso),
  )
  const porSalir = mias.filter((p) => p.paso === "por_salir")
  const recojos = all.filter(
    (p) =>
      p.vuelta?.estado === "aprobado" &&
      p.vuelta.como.startsWith("recojo") &&
      (p.vuelta.repartidor ?? "Kevin") === "Kevin" &&
      p.vuelta.dia === "Hoy",
  )
  const hoy = all.flatMap((p) => p.pagos).filter((g) => g.quien === "Kevin" && g.cuando.startsWith("Hoy"))
  const de = (m: Medio[]) => hoy.filter((g) => m.includes(g.medio)).reduce((a, g) => a + g.monto, 0)
  const efectivo = de(["efectivo"])
  const pos = de(["pos"])
  const yape = de(["yape", "plin"])
  const vuelto = mias.filter((x) => x.paso !== "entregado").reduce((a, x) => a + vueltoDe(x), 0)
  const p = cobrando ? all.find((x) => x.id === cobrando) : undefined
  return (
    <Confirma.Provider value={setConf}>
    <div className="relative flex h-full flex-col bg-muted/40" data-brand="gestoria">
      <div className="flex items-center gap-2 border-b bg-card px-4 py-3">
        <span className="flex-1">
          <b className="block text-[15px]">Hoy · jueves 27</b>
          <span className="text-xs text-muted-foreground">
            Kevin · {mias.length + 1} entregas{recojos.length ? ` y ${recojos.length} recojo` : ""} de 2 tiendas
          </span>
        </span>
        <Badge variant="secondary">gestorIA Reparto</Badge>
      </div>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
        <section className="flex flex-col gap-2">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <span className="size-3 rounded-full" style={{ background: R.store.color }} />
            {R.store.name}
            <span className="font-normal text-muted-foreground">· {mias.length + recojos.length}</span>
          </span>
          {vuelto ? (
            <p className="flex items-center gap-2 rounded-xl bg-warning-soft px-3 py-2 text-sm">
              <Banknote className="size-4 shrink-0" aria-hidden />
              Sal con {money(vuelto)} en sencillo para los vueltos.
            </p>
          ) : null}
          {porSalir.length ? (
            <Button
              onClick={() =>
                setConf({
                  titulo: `¿Sales con ${porSalir.length === 1 ? "este pedido" : `estos ${porSalir.length}`}?`,
                  filas: porSalir.map((x) => [
                    `${x.id} · ${nombreCorto(x)}`,
                    `${x.entrega.zona.split(",")[0]} · ${cuentas(x).falta ? `cobra ${money(cuentas(x).falta)}` : "pagado"}`,
                  ]),
                  boton: "Sí, salí",
                  hacer: () => {
                for (const x of porSalir)
                  mover(
                    rubro,
                    x.id,
                    (y) => {
                      y.paso = "en_camino"
                      avisar(
                        y,
                        "salio",
                        `Tu pedido salió: llega hoy entre ${y.entrega.franja} con Kevin.`,
                      )
                    },
                    {
                      actor: "repartidor",
                      quien: "Kevin",
                      texto: "Tocó «Salí» en su app.",
                      paso: "en_camino",
                    },
                  )
                toast.success(`Salió con ${porSalir.length}. Sofi les avisó.`)
                  },
                })
              }
            >
              Salí con {porSalir.length === 1 ? "el" : `los ${porSalir.length}`}
            </Button>
          ) : null}
          <ul className="flex flex-col gap-2">
            {recojos.map((x) => (
              <Recoger key={x.id} p={x} />
            ))}
            {mias
              .filter((x) => x.paso !== "preparando")
              .map((x) => (
                <Entrega key={x.id} p={x} onCobrar={() => setCobrando(x.id)} />
              ))}
            {mias.some((x) => x.paso === "preparando") ? (
              <li className="rounded-xl border border-dashed p-3 text-xs text-muted-foreground">
                {mias.filter((x) => x.paso === "preparando").length} más se están empacando en la
                tienda.
              </li>
            ) : null}
          </ul>
        </section>
        <section className="flex flex-col gap-2">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <span className="size-3 rounded-full bg-[#15803d]" />
            Hoja Viva
            <span className="font-normal text-muted-foreground">· 1</span>
          </span>
          <div className="flex items-center gap-2 rounded-xl border bg-card p-3 text-sm">
            <span className="flex-1">
              <b className="block">0094 · María F.</b>
              <span className="text-xs text-muted-foreground">
                Miraflores · recoger desde las 4 p. m.
              </span>
            </span>
            <Badge variant="success">Pagado</Badge>
          </div>
        </section>
      </div>
      <div className="flex flex-col gap-0.5 border-t bg-card px-4 py-2.5 text-sm">
        <span className="flex items-center justify-between">
          <span className="text-muted-foreground">Mi plata hoy · entrego a Caja</span>
          <b className="tabular-nums">{money(efectivo)}</b>
        </span>
        <span className="text-xs text-muted-foreground">
          Efectivo {money(efectivo)} · POS {money(pos)} · Yape o Plin {money(yape)}
        </span>
      </div>
      {p ? <Cobrar p={p} onClose={() => setCobrando(null)} /> : null}
      {conf ? <HojaConfirmar c={conf} onClose={() => setConf(null)} /> : null}
    </div>
    </Confirma.Provider>
  )
}

export function RepartoPage() {
  const isMobile = useIsMobile()
  return (
    <PageShell className="flex flex-col gap-5">
      <PageHeader
        title="La app del repartidor"
        secondary={{
          label: "Volver a Pedidos",
          icon: <ArrowLeft aria-hidden />,
          onClick: () => ir("/pedidos"),
        }}
      />
      <p className="max-w-3xl text-sm text-muted-foreground">
        Kevin reparte para varias tiendas con una sola app, gestorIA Reparto. Toca «Salí» y
        «Entregado»; si hay que cobrar, cobra en la puerta. «Entregado» se activa solo con el pago
        confirmado. Prueba cobrarle a Diana o a Rocío.
      </p>
      {isMobile ? (
        <div className="relative h-[720px] overflow-hidden rounded-2xl border">
          <App />
        </div>
      ) : (
        <div className="flex justify-center">
          <PhoneFrame height={760}>
            <App />
          </PhoneFrame>
        </div>
      )}
    </PageShell>
  )
}

import { Badge, Button, buttonVariants, cn, Input, useIsMobile } from "@odentia/ui"
import { PageHeader, PageShell } from "@odentia/ui-patterns"
import {
  ArrowLeft,
  Banknote,
  Camera,
  Check,
  CreditCard,
  Lock,
  MapPin,
  Navigation,
  Package,
  Phone,
  QrCode,
  RotateCcw,
  Smartphone,
  Undo2,
} from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { foto, RUBROS } from "../datos"
import { ir, useRuta } from "../ruta"
import { PhoneFrame } from "../vitrina/marcos"
import { cobroDe, MOTIVOS_NO, noRecibio, vueltoDe } from "./cobros"
import { CapturaPago, VoucherPos } from "./ejemplos"
import {
  avisar,
  cuentas,
  type Linea,
  type Medio,
  money,
  mover,
  nuevoId,
  type Pedido,
  reponer,
  usePedidos,
} from "./modelo"
import { recogido } from "./vuelta"

/**
 * gestorIA Reparto. Cada acción del repartidor abre su propia pantalla completa: arriba la
 * clienta, en el medio lo que cobra, entrega o recoge (con su foto) y las opciones grandes, y abajo,
 * fijo, el botón que confirma. Ese botón se activa solo cuando está todo. La tarjeta de la lista no
 * se expande nunca: muestra el pedido y su botón. Al confirmar, vuelve a la lista con el resumen,
 * «Deshacer» y el siguiente pedido de la ruta marcado.
 */
type Pantalla =
  | { t: "salir" }
  | { t: "entregar"; id: string }
  | { t: "no"; id: string }
  | { t: "recoger"; id: string }
  | { t: "agencia"; id: string }

interface Hecho {
  texto: string
  copias: Pedido[]
  /** El pedido que se acaba de atender: el siguiente de la ruta va después. */
  id?: string
}

type Hacer = (texto: string, ids: string[], fn: () => void) => void

const nombre = (p: Pedido) => p.clienta.split(" ")[0]!
const nombreCorto = (p: Pedido) => `${nombre(p)} ${p.clienta.split(" ")[1]?.[0] ?? ""}.`
const seLleva = (p: Pedido) => p.lineas.filter((l) => !l.vuelve)
const seRecoge = (p: Pedido) => p.lineas.filter((l) => l.vuelve)
const mapa = (p: Pedido) =>
  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(`${p.entrega.direccion}, ${p.entrega.zona}`)}`

/* ---------- Las piezas de una pantalla ---------- */

function Pantalla({
  p,
  titulo,
  onVolver,
  pie,
  children,
}: {
  p?: Pedido
  titulo: string
  onVolver: () => void
  pie: ReactNode
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => ref.current?.focus(), [])
  return (
    <div
      ref={ref}
      tabIndex={-1}
      role="dialog"
      aria-modal="true"
      aria-label={p ? `${titulo} · ${p.id} · ${nombreCorto(p)}` : titulo}
      // En el celular cubre toda la pantalla; a 1440, el marco del celular.
      className="absolute inset-0 z-20 flex flex-col bg-background outline-none max-md:fixed max-md:z-50"
    >
      <div className="flex flex-col gap-2 border-b bg-card px-3 pt-2 pb-3">
        <span className="flex items-center gap-2">
          <Button variant="ghost" className="-ml-1 h-11 px-2 text-[15px]" onClick={onVolver}>
            <ArrowLeft aria-hidden />
            Volver
          </Button>
          <span className="ml-auto text-sm font-semibold">{titulo}</span>
        </span>
        {p ? (
          <>
            <span className="px-1">
              <b className="block text-lg leading-tight">{p.clienta}</b>
              <span className="text-sm text-muted-foreground">
                {p.id} · {conDistrito(p.entrega.direccion, p.entrega.zona)}
              </span>
            </span>
            <span className="flex gap-2">
              <Button variant="outline" className="h-11 flex-1" aria-label={`Llamar a ${nombre(p)}`}>
                <Phone aria-hidden />
                Llamar
              </Button>
              <a
                href={mapa(p)}
                target="_blank"
                rel="noreferrer"
                className={cn(buttonVariants({ variant: "outline" }), "h-11 flex-1")}
              >
                <Navigation aria-hidden />
                Abrir el mapa
              </a>
            </span>
          </>
        ) : null}
      </div>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-4">{children}</div>
      <div className="flex flex-col gap-1.5 border-t bg-card p-3">{pie}</div>
    </div>
  )
}

/** Lo que se entrega o se recoge, con su foto grande. */
function Productos({ titulo, lineas }: { titulo: string; lineas: Linea[] }) {
  if (!lineas.length) return null
  return (
    <section className="flex flex-col gap-2">
      <b className="text-sm">{titulo}</b>
      {lineas.map((l) => (
        <span key={l.id} className="flex items-center gap-3 rounded-xl border bg-card p-2">
          <img src={foto(l.foto)} alt="" className="size-20 shrink-0 rounded-lg object-cover" />
          <span className="text-[15px]">
            <b className="block">{l.nombre}</b>
            {l.variante}
            {l.qty > 1 ? ` · ${l.qty} unidades` : ""}
          </span>
        </span>
      ))}
    </section>
  )
}

/** Una opción grande, a un dedo. */
function Opcion({
  activa,
  onClick,
  icono,
  titulo,
  detalle,
}: {
  activa: boolean
  onClick: () => void
  icono?: ReactNode
  titulo: string
  detalle?: string
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={activa}
      onClick={onClick}
      className={cn(
        "flex min-h-14 items-center gap-3 rounded-xl border bg-card px-3 py-2.5 text-left",
        activa && "border-primary bg-primary-soft ring-2 ring-primary",
      )}
    >
      {icono}
      <span className="min-w-0 flex-1">
        <b className="block text-[15px]">{titulo}</b>
        {detalle ? <span className="text-sm text-muted-foreground">{detalle}</span> : null}
      </span>
      <span
        className={cn(
          "flex size-6 shrink-0 items-center justify-center rounded-full border-2",
          activa ? "border-primary bg-primary text-primary-foreground" : "border-muted-foreground/40",
        )}
        aria-hidden
      >
        {activa ? <Check className="size-4" /> : null}
      </span>
    </button>
  )
}

/** La foto que hay que tomar: un botón de cámara grande y, ya tomada, la foto. */
function Foto({
  que,
  tomada,
  onTomar,
  vista,
}: {
  que: string
  tomada: boolean
  onTomar: () => void
  vista: ReactNode
}) {
  return tomada ? (
    <div className="flex flex-col gap-2">
      <div className="mx-auto w-44">{vista}</div>
      <Button variant="outline" className="h-12" onClick={onTomar}>
        <RotateCcw aria-hidden />
        Volver a tomar la foto
      </Button>
    </div>
  ) : (
    <button
      type="button"
      onClick={onTomar}
      className="flex h-32 flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed border-primary/50 bg-primary-soft text-[15px] font-semibold text-primary-soft-foreground"
    >
      <Camera className="size-10" aria-hidden />
      Tomar la foto {que}
    </button>
  )
}

/** El botón de abajo: se activa solo cuando está todo; si falta algo, lo dice. */
function Confirmar({
  falta,
  children,
  onClick,
  peligro,
}: {
  falta?: string
  children: ReactNode
  onClick: () => void
  peligro?: boolean
}) {
  return (
    <>
      {falta ? <span className="text-center text-sm text-muted-foreground">{falta}</span> : null}
      <Button
        variant={peligro ? "destructive" : "default"}
        className="h-14 w-full text-base"
        disabled={!!falta}
        onClick={onClick}
      >
        {falta ? <Lock aria-hidden /> : <Check aria-hidden />}
        {children}
      </Button>
    </>
  )
}

/* ---------- Salir ---------- */

function Salir({ lista, onVolver, hacer }: { lista: Pedido[]; onVolver: () => void; hacer: Hacer }) {
  const { rubro } = useRuta()
  const sencillo = lista.reduce((a, x) => a + vueltoDe(x), 0)
  const n = lista.length
  return (
    <Pantalla
      titulo={`Salir · ${RUBROS[rubro].store.name}`}
      onVolver={onVolver}
      pie={
        <Confirmar
          onClick={() =>
            hacer(
              `Listo: saliste con ${n === 1 ? "1 pedido" : `los ${n}`}. Sofi les avisó.`,
              lista.map((x) => x.id),
              () => {
                for (const x of lista)
                  mover(
                    rubro,
                    x.id,
                    (y) => {
                      y.paso = "en_camino"
                      avisar(y, "salio", `Tu pedido salió: llega hoy entre ${y.entrega.franja} con Kevin.`)
                    },
                    { actor: "repartidor", quien: "Kevin", texto: "Tocó «Salí» en su app.", paso: "en_camino" },
                  )
              },
            )
          }
        >
          Salí con {n === 1 ? "este pedido" : `los ${n}`}
        </Confirmar>
      }
    >
      <p className="text-[15px]">
        Revisa que llevas {n === 1 ? "este paquete" : `estos ${n} paquetes`}, en el orden de la ruta.
      </p>
      {sencillo ? (
        <p className="flex items-center gap-2 rounded-xl bg-warning-soft px-3 py-3 text-[15px] font-medium">
          <Banknote className="size-5 shrink-0" aria-hidden />
          Lleva {money(sencillo)} en sencillo para los vueltos.
        </p>
      ) : null}
      <ol className="flex flex-col gap-3">
        {lista.map((x, i) => {
          const k = cuentas(x)
          return (
            <li key={x.id} className="flex gap-3 rounded-xl border bg-card p-3">
              <span className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-sm font-bold text-primary-foreground">
                {i + 1}
              </span>
              <span className="flex min-w-0 flex-1 flex-col gap-2">
                <span>
                  <b className="block text-[15px]">
                    {x.id} · {nombreCorto(x)}
                  </b>
                  <span className="text-sm text-muted-foreground">
                    {x.entrega.zona.split(",")[0]} · {x.entrega.franja}
                  </span>
                </span>
                <span className="flex flex-wrap gap-2">
                  {seLleva(x).map((l) => (
                    <img
                      key={l.id}
                      src={foto(l.foto)}
                      alt={`${l.nombre} · ${l.variante}`}
                      className="size-16 rounded-lg object-cover"
                    />
                  ))}
                </span>
                <span className="text-sm font-medium">
                  {k.falta ? `Cobra ${money(k.falta)}` : "Pagado: no cobra"}
                  {vueltoDe(x) ? ` · vuelto de ${money(vueltoDe(x))}` : ""}
                </span>
              </span>
            </li>
          )
        })}
      </ol>
    </Pantalla>
  )
}

/* ---------- Cobrar y entregar ---------- */

type Forma = "link" | "efectivo" | "yape" | "pos"
const FORMAS: [Forma, string, string, typeof QrCode][] = [
  ["efectivo", "Efectivo", "Lo confirmas tú al recibirlo.", Banknote],
  ["link", "Con su link: Yape o tarjeta", "Escanea el código. Se confirma solo.", QrCode],
  ["pos", "Tarjeta, con el POS", "Tomas la foto del voucher aprobado.", CreditCard],
  ["yape", "Yape o Plin a la tienda", "Tomas la foto de su captura. La confirma la tienda.", Smartphone],
]

function Entregar({
  p,
  onVolver,
  onNo,
  hacer,
}: {
  p: Pedido
  onVolver: () => void
  onNo: () => void
  hacer: Hacer
}) {
  const { rubro } = useRuta()
  const tienda = RUBROS[rubro].store.name
  const k = cuentas(p)
  const n = nombre(p)
  const [forma, setForma] = useState<Forma | null>(null)
  const [recibi, setRecibi] = useState(p.pagaCon && vueltoDe(p) ? String(p.pagaCon) : "")
  const [fotoOk, setFoto] = useState(false)
  const esperaTienda = p.pagos.some((x) => x.estado === "por_confirmar")
  const confirmado = k.falta === 0 && k.porConfirmar === 0
  const efectivo = Number(recibi.replace(",", ".")) || 0
  const cobrar = (medio: Medio, texto: string) =>
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
          quien: medio === "link" ? "la pasarela" : "Kevin",
        })
      },
      { actor: medio === "link" ? "pasarela" : "repartidor", quien: medio === "link" ? "La pasarela" : "Kevin", texto },
    )
  const entregar = () =>
    mover(
      rubro,
      p.id,
      (x) => {
        x.paso = "entregado"
        avisar(x, "entregado", "Kevin dejó tu pedido. ¿Te llegó bien?")
      },
      { actor: "repartidor", quien: "Kevin", texto: "Tocó «Entregado».", paso: "entregado" },
    )
  const recoge = seRecoge(p)
  const listo = (como: string) =>
    `Listo: entregaste el pedido de ${n}${como ? ` · ${como}` : ""}${recoge.length ? " y recogiste el cambio" : ""}.`
  const pago = { id: "foto", medio: forma === "pos" ? "pos" : "yape", monto: k.falta, estado: "por_confirmar", cuando: "Hoy · ahora" } as const

  let pie: ReactNode
  if (confirmado)
    pie = (
      <Confirmar onClick={() => hacer(listo(k.confirmado ? `${money(k.confirmado)} pagado` : ""), [p.id], entregar)}>
        Entregado
      </Confirmar>
    )
  else if (esperaTienda)
    pie = <Confirmar falta="Espera que la tienda confirme el Yape." onClick={() => {}}>Entregado</Confirmar>
  else if (forma === "efectivo")
    pie = (
      <Confirmar
        falta={efectivo < k.falta ? `Escribe cuánto te dio: al menos ${money(k.falta)}.` : undefined}
        onClick={() =>
          hacer(listo(`${money(k.falta)} en efectivo`), [p.id], () => {
            cobrar("efectivo", `Cobró ${money(k.falta)} en efectivo${efectivo > k.falta ? ` (le dio ${money(efectivo)}, vuelto ${money(efectivo - k.falta)})` : ""}. Lo entrega en Caja.`)
            entregar()
          })
        }
      >
        Recibí {money(k.falta)} · Entregado
      </Confirmar>
    )
  else if (forma === "pos")
    pie = (
      <Confirmar
        falta={fotoOk ? undefined : "Toma la foto del voucher aprobado."}
        onClick={() =>
          hacer(listo(`${money(k.falta)} con el POS`), [p.id], () => {
            cobrar("pos", `Cobró ${money(k.falta)} con el POS. Subió la foto del voucher aprobado.`)
            entregar()
          })
        }
      >
        Voucher aprobado · Entregado
      </Confirmar>
    )
  else if (forma === "yape")
    pie = (
      <Confirmar
        falta={fotoOk ? undefined : "Toma la foto de su captura."}
        onClick={() =>
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
                captura: { monto: cuentas(x).falta, nombre: nombreCorto(p), hora: "ahora" },
              })
              x.toca = {
                texto: `Kevin está en la puerta de ${n}: yapeó ${money(cuentas(x).falta)} al número de la tienda.`,
                boton: "Ver y confirmar",
                accion: "confirmar",
                urgente: true,
              }
            },
            { actor: "repartidor", quien: "Kevin", texto: `Subió la foto del Yape de ${n} en la puerta. Espera que la tienda lo confirme.` },
          )
        }
      >
        Mandar la captura a la tienda
      </Confirmar>
    )
  else
    pie = (
      <Confirmar falta={forma === "link" ? "Espera que pague con el código." : "Elige cómo pagó."} onClick={() => {}}>
        Entregado
      </Confirmar>
    )

  return (
    <Pantalla p={p} titulo={confirmado ? "Entregar" : "Cobrar y entregar"} onVolver={onVolver} pie={pie}>
      <section className="text-center">
        <span className="text-sm text-muted-foreground">{confirmado ? "Ya está pagado" : "Cobra"}</span>
        <b className="block font-heading text-5xl tabular-nums">{money(confirmado ? k.confirmado : k.falta || k.porConfirmar)}</b>
        {k.confirmado && !confirmado ? (
          <span className="text-sm text-muted-foreground">Ya pagó {money(k.confirmado)} antes</span>
        ) : null}
        {vueltoDe(p) && !confirmado ? (
          <span className="mt-2 flex items-center justify-center gap-2 rounded-xl bg-warning-soft px-3 py-3 text-base font-semibold">
            <Banknote className="size-5" aria-hidden />
            Paga con {money(p.pagaCon!)}: vuelto de {money(vueltoDe(p))}
          </span>
        ) : null}
      </section>
      <Productos titulo="Entregas" lineas={seLleva(p)} />
      <Productos titulo="Recoges, con su foto" lineas={recoge} />
      {confirmado ? (
        <p className="flex items-center justify-center gap-2 rounded-xl bg-success-soft p-3 text-base font-semibold text-success">
          <Check className="size-5" aria-hidden />
          Pago confirmado
        </p>
      ) : esperaTienda ? (
        <div className="flex flex-col gap-2 rounded-xl bg-warning-soft p-3 text-[15px]">
          <b>Esperando a la tienda</b>
          La tienda está revisando el Yape en su app. Cuando lo confirme, se activa «Entregado».
          <Button
            variant="outline"
            className="propuesta h-11 self-start"
            onClick={() =>
              mover(
                rubro,
                p.id,
                (x) => {
                  const g = x.pagos.find((y) => y.estado === "por_confirmar")
                  if (g) (g.estado = "confirmado"), (g.quien = "Lucía")
                  x.toca = undefined
                },
                { actor: "persona", quien: "Lucía", texto: "Confirmó el Yape en la puerta: Kevin ya puede entregar." },
              )
            }
          >
            Prototipo: Lucía lo confirma
          </Button>
        </div>
      ) : (
        <section className="flex flex-col gap-2">
          <b id={`como-${p.id}`} className="text-sm">
            ¿Cómo pagó?
          </b>
          <div className="flex flex-col gap-2" role="radiogroup" aria-labelledby={`como-${p.id}`}>
            {FORMAS.map(([v, l, d, I]) => (
              <Opcion
                key={v}
                activa={forma === v}
                onClick={() => (setForma(v), setFoto(false))}
                icono={<I className="size-6 shrink-0 text-muted-foreground" aria-hidden />}
                titulo={l}
                detalle={d}
              />
            ))}
          </div>
          {forma === "efectivo" ? (
            <label className="flex flex-col gap-1 rounded-xl border p-3 text-[15px]">
              <b>¿Cuánto te dio?</b>
              <span className="flex items-center gap-2">
                S/
                <Input
                  inputMode="decimal"
                  value={recibi}
                  onChange={(e) => setRecibi(e.target.value)}
                  className="h-14 flex-1 text-2xl tabular-nums"
                  placeholder={String(k.falta)}
                />
              </span>
              {efectivo > k.falta ? (
                <b className="text-lg">Dale de vuelto {money(efectivo - k.falta)}</b>
              ) : null}
            </label>
          ) : null}
          {forma === "link" ? (
            <div className="flex flex-col items-center gap-2 rounded-xl border p-4">
              <QrCode className="size-32" aria-hidden />
              <span className="text-sm text-muted-foreground">El código del mismo link de {n}</span>
              <Button
                variant="outline"
                className="propuesta h-11"
                onClick={() => cobrar("link", `${n} pagó con el código en la puerta. Lo confirmó la pasarela, sola.`)}
              >
                Prototipo: {n} paga
              </Button>
            </div>
          ) : null}
          {forma === "pos" || forma === "yape" ? (
            <Foto
              que={forma === "pos" ? "del voucher" : "de su captura"}
              tomada={fotoOk}
              onTomar={() => setFoto(true)}
              vista={
                forma === "pos" ? (
                  <VoucherPos p={p} g={{ ...pago, medio: "pos" }} tienda={tienda} />
                ) : (
                  <CapturaPago p={p} g={{ ...pago, medio: "yape" }} tienda={tienda} />
                )
              }
            />
          ) : null}
        </section>
      )}
      <Button variant="outline" className="h-12 text-destructive" onClick={onNo}>
        No se entregó
      </Button>
    </Pantalla>
  )
}

/* ---------- No se entregó ---------- */

function NoSeEntrego({ p, onVolver, hacer }: { p: Pedido; onVolver: () => void; hacer: Hacer }) {
  const { rubro } = useRuta()
  const [motivo, setMotivo] = useState<string | null>(null)
  const n = nombre(p)
  const viaje = cobroDe(rubro).viaje === "clienta"
  const pasa = (m: string) =>
    m === MOTIVOS_NO[0]
      ? "Vuelve contigo. Sofi le escribe para llevárselo mañana."
      : `Lo traes de vuelta a la tienda. Sofi le pregunta si lo quiere otro día; ${viaje ? `el viaje (${money(p.entrega.envio)}) va a su saldo, como dice la política` : "el viaje lo paga la tienda"}.`
  return (
    <Pantalla
      p={p}
      titulo="No se entregó"
      onVolver={onVolver}
      pie={
        <Confirmar
          peligro
          falta={motivo ? undefined : "Elige qué pasó."}
          onClick={() =>
            hacer(
              motivo === MOTIVOS_NO[0]
                ? `Listo: ${n} no estaba. Sofi le escribe para mañana.`
                : `Listo: el pedido de ${n} vuelve a la tienda contigo.`,
              [p.id],
              () => {
                if (motivo && motivo !== MOTIVOS_NO[0]) return noRecibio(rubro, p, "Kevin", motivo)
                mover(
                  rubro,
                  p.id,
                  (x) => {
                    x.paso = "por_salir"
                    x.noEntregado = "No estaba: nadie abrió."
                    x.entrega.dia = "Vie 28"
                    avisar(x, "falla", `No te encontramos en casa, ${n}. ¿Te lo llevamos mañana entre ${p.entrega.franja}?`)
                  },
                  { actor: "repartidor", quien: "Kevin", texto: "«No estaba»: nadie abrió. Sofi le escribió para otro día.", paso: "por_salir" },
                )
              },
            )
          }
        >
          No se entregó
        </Confirmar>
      }
    >
      <Productos titulo="Lo que llevas" lineas={seLleva(p)} />
      <section className="flex flex-col gap-2">
        <b id={`no-${p.id}`} className="text-sm">
          ¿Qué pasó?
        </b>
        <div className="flex flex-col gap-2" role="radiogroup" aria-labelledby={`no-${p.id}`}>
          {MOTIVOS_NO.map((m) => (
            <Opcion key={m} activa={motivo === m} onClick={() => setMotivo(m)} titulo={m} />
          ))}
        </div>
      </section>
      {motivo ? (
        <p className="rounded-xl bg-muted p-3 text-[15px]">
          <b className="block">Qué pasa</b>
          {pasa(motivo)}
        </p>
      ) : null}
    </Pantalla>
  )
}

/* ---------- Recoger ---------- */

const ESTADOS = ["Sin uso, con su caja", "Con uso", "Con falla"] as const

function Recoger({ p, onVolver, hacer }: { p: Pedido; onVolver: () => void; hacer: Hacer }) {
  const { rubro } = useRuta()
  const v = p.vuelta!
  const [fotoOk, setFoto] = useState(false)
  const [estado, setEstado] = useState<string | null>(v.motivo === "falla" ? "Con falla" : null)
  const l = v.vuelven[0]!
  const falta = !fotoOk && !estado ? "Toma la foto y elige cómo está." : !fotoOk ? "Toma la foto de cómo está." : !estado ? "Elige cómo está." : undefined
  return (
    <Pantalla
      p={p}
      titulo="Recoger"
      onVolver={onVolver}
      pie={
        <Confirmar
          falta={falta}
          onClick={() =>
            hacer(
              `Listo: recogiste ${rubro === "calzado" ? "el par" : "el producto"} de ${nombre(p)}.`,
              [p.id],
              () => recogido(rubro, p, "Kevin", estado!.toLowerCase()),
            )
          }
        >
          Recogí
        </Confirmar>
      }
    >
      <p className="rounded-xl bg-success-soft p-3 text-center text-base font-semibold text-success">
        No cobras nada
      </p>
      <section className="flex flex-col gap-2">
        <b className="text-sm">Recoges</b>
        <span className="flex items-center gap-3 rounded-xl border bg-card p-2">
          {l.foto ? <img src={foto(l.foto)} alt="" className="size-20 shrink-0 rounded-lg object-cover" /> : null}
          <span className="text-[15px]">
            <b className="block">{l.nombre}</b>
            {l.variante}
          </span>
        </span>
      </section>
      <section className="flex flex-col gap-2">
        <b className="text-sm">La foto de cómo está</b>
        <Foto
          que="de cómo está"
          tomada={fotoOk}
          onTomar={() => setFoto(true)}
          vista={l.foto ? <img src={foto(l.foto)} alt="Foto al recoger" className="aspect-square w-full rounded-xl object-cover" /> : null}
        />
      </section>
      <section className="flex flex-col gap-2">
        <b id={`est-${p.id}`} className="text-sm">
          ¿Cómo está?
        </b>
        <div className="flex flex-col gap-2" role="radiogroup" aria-labelledby={`est-${p.id}`}>
          {ESTADOS.map((e) => (
            <Opcion key={e} activa={estado === e} onClick={() => setEstado(e)} titulo={e} />
          ))}
        </div>
      </section>
    </Pantalla>
  )
}

/* ---------- Dejar en la agencia ---------- */

function Agencia({ p, onVolver, hacer }: { p: Pedido; onVolver: () => void; hacer: Hacer }) {
  const { rubro } = useRuta()
  const ag = p.entrega.agencia ?? "la agencia"
  const [num, setNum] = useState("")
  const [fotoOk, setFoto] = useState(false)
  const limpio = num.replace(/\D/g, "")
  const falta =
    limpio.length < 5 && !fotoOk
      ? "Escribe el N.º de envío y toma la foto del comprobante."
      : limpio.length < 5
        ? "Escribe el N.º de envío."
        : !fotoOk
          ? "Toma la foto del comprobante."
          : undefined
  const destino = p.entrega.zona.split(",")[0]
  return (
    <Pantalla
      titulo={`Dejar en ${ag}`}
      onVolver={onVolver}
      pie={
        <Confirmar
          falta={falta}
          onClick={() =>
            hacer(`Listo: dejaste el pedido de ${nombre(p)} en ${ag}, N.º ${limpio}. Sofi le avisó.`, [p.id], () =>
              mover(
                rubro,
                p.id,
                (x) => {
                  x.entrega.numero = limpio
                  x.paso = "en_camino"
                  x.toca = undefined
                  avisar(
                    x,
                    "salio",
                    `${nombre(p)}, tu pedido ${p.id} va por ${ag}, número de envío ${limpio}. Lo recoges en su agencia de ${destino}.`,
                  )
                },
                {
                  actor: "repartidor",
                  quien: "Kevin",
                  texto: `Lo dejó en ${ag}: N.º ${limpio}. Subió la foto del comprobante.`,
                  paso: "en_camino",
                },
              ),
            )
          }
        >
          Lo dejé en {ag}
        </Confirmar>
      }
    >
      <section className="px-1">
        <b className="block text-lg leading-tight">{p.clienta}</b>
        <span className="text-sm text-muted-foreground">
          {p.id} · va a {destino}. Lo recoge ella en {ag}.
        </span>
      </section>
      <p className="rounded-xl bg-success-soft p-3 text-center text-base font-semibold text-success">
        No cobras nada{cuentas(p).falta === 0 ? ": ya está pagado" : ""}
      </p>
      <Productos titulo="Llevas a la agencia" lineas={seLleva(p)} />
      <label className="flex flex-col gap-1 rounded-xl border p-3 text-[15px]">
        <b>N.º de envío de {ag}</b>
        <span className="text-sm text-muted-foreground">Está en el comprobante que te dan.</span>
        <Input
          inputMode="numeric"
          autoComplete="off"
          value={num}
          onChange={(e) => setNum(e.target.value)}
          className="h-14 text-2xl tabular-nums"
          placeholder="7 a 10 números"
        />
      </label>
      <section className="flex flex-col gap-2">
        <b className="text-sm">La foto del comprobante</b>
        <Foto
          que="del comprobante"
          tomada={fotoOk}
          onTomar={() => setFoto(true)}
          vista={
            <span className="flex aspect-[3/4] w-full flex-col justify-center gap-1 rounded-xl border bg-card p-3 text-center text-sm">
              <b>{ag}</b>
              <span>Envío N.º {limpio || "…"}</span>
              <span className="text-muted-foreground">Destino: {destino}</span>
              <span className="mt-2 text-xs font-bold tracking-widest text-muted-foreground">EJEMPLO</span>
            </span>
          }
        />
      </section>
    </Pantalla>
  )
}

/* ---------- La lista ---------- */

/** La tarjeta de la lista: el pedido y su botón. No se expande nunca. */
function Tarjeta({
  p,
  recojo,
  siguiente,
  onAbrir,
}: {
  p: Pedido
  recojo?: boolean
  siguiente?: boolean
  onAbrir?: () => void
}) {
  const k = cuentas(p)
  const pagado = k.falta === 0 && k.porConfirmar === 0
  const hecho = recojo ? p.vuelta?.estado !== "aprobado" : p.paso === "entregado" || !!p.rechazo
  const l = recojo ? p.vuelta!.vuelven[0]! : seLleva(p)[0]
  const que = recojo
    ? `Recoge ${l?.nombre} · ${l?.variante}. No cobra.`
    : p.rechazo
      ? `${p.rechazo.motivo}. Tráelo a la tienda y entrégalo con tu plata.`
      : pagado
        ? "Pagado: no cobra"
        : `Cobra ${money(k.falta || k.porConfirmar)}`
  return (
    <li
      data-pedido={p.id}
      className={cn(
        "flex scroll-mt-16 flex-col gap-2 rounded-xl border bg-card p-3",
        recojo && "border-primary/40",
        hecho && "opacity-60",
        siguiente && "ring-2 ring-primary",
      )}
    >
      {siguiente ? <span className="text-xs font-semibold text-primary">Sigue</span> : null}
      <span className="flex items-start gap-3">
        {l?.foto ? <img src={foto(l.foto)} alt="" className="size-12 shrink-0 rounded-lg object-cover" /> : null}
        <span className="min-w-0 flex-1">
          <b className="block text-[15px]">
            {p.id} · {nombreCorto(p)}
          </b>
          <span className="flex items-start gap-1 text-sm text-muted-foreground">
            <MapPin className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            {p.entrega.direccion}
          </span>
        </span>
        {p.rechazo ? (
          <Badge variant="destructive">Vuelve a la tienda</Badge>
        ) : hecho ? (
          <Badge variant="success">{recojo ? "Recogido" : "Entregado"}</Badge>
        ) : recojo ? (
          <Badge variant="soft">Recoger</Badge>
        ) : null}
      </span>
      <span className="text-sm font-medium">{que}</span>
      {vueltoDe(p) && !hecho ? (
        <span className="flex items-center gap-1.5 rounded-lg bg-warning-soft px-2 py-1 text-sm font-medium">
          <Banknote className="size-4" aria-hidden />
          Lleva vuelto de {money(vueltoDe(p))} · paga con {money(p.pagaCon!)}
        </span>
      ) : null}
      {!recojo && p.cambioDe && seRecoge(p).length && !hecho ? (
        <span className="rounded-lg bg-primary-soft px-2 py-1 text-sm text-primary-soft-foreground">
          Lleva {seLleva(p)[0]?.variante} · recoge {seRecoge(p)[0]?.variante}, con su foto
        </span>
      ) : null}
      {onAbrir && !hecho ? (
        <span className="flex gap-2">
          <Button variant="outline" className="h-11 w-12" aria-label={`Llamar a ${nombre(p)}`}>
            <Phone aria-hidden />
          </Button>
          <Button className="h-11 flex-1" onClick={onAbrir}>
            {recojo ? "Recoger" : pagado ? "Entregado" : "Cobrar y entregar"}
          </Button>
        </span>
      ) : null}
    </li>
  )
}

/** gestorIA Reparto: la app del repartidor, para todas sus tiendas. Aquí, solo lo de este flujo. */
function App() {
  const { rubro } = useRuta()
  const R = RUBROS[rubro]
  const all = usePedidos(rubro)
  const [pantalla, setPantalla] = useState<Pantalla | null>(null)
  const [hecho, setHecho] = useState<Hecho | null>(null)
  const lista = useRef<HTMLDivElement>(null)
  const mias = all.filter(
    (p) =>
      p.entrega.repartidor === "Kevin" &&
      p.entrega.dia === "Hoy" &&
      ["por_salir", "en_camino", "entregado", "preparando"].includes(p.paso),
  )
  const porSalir = mias.filter((p) => p.paso === "por_salir")
  const recojos = all.filter(
    (p) =>
      p.vuelta?.como.startsWith("recojo") &&
      ["aprobado", "recibido"].includes(p.vuelta.estado) &&
      (p.vuelta.repartidor ?? "Kevin") === "Kevin" &&
      p.vuelta.dia === "Hoy",
  )
  /** Lo que sale hoy por agencia, sin N.º todavía: Kevin lo deja de camino. */
  const agencias = all.filter(
    (p) =>
      p.entrega.tipo === "agencia" &&
      p.entrega.dia === "Hoy" &&
      !p.entrega.numero &&
      ["preparando", "por_salir"].includes(p.paso),
  )
  const ruta = mias.filter((x) => x.paso !== "preparando" && x.paso !== "por_salir")
  /** La ruta en orden: los recojos y las entregas que faltan. */
  const pendientes = [
    ...recojos.filter((x) => x.vuelta?.estado === "aprobado").map((x) => x.id),
    ...ruta.filter((x) => x.paso === "en_camino" && !x.rechazo).map((x) => x.id),
  ]
  const orden = [...recojos.map((x) => x.id), ...ruta.map((x) => x.id)]
  const sigue = hecho
    ? (orden.slice(orden.indexOf(hecho.id ?? "") + 1).find((x) => pendientes.includes(x)) ?? pendientes[0])
    : undefined
  useEffect(() => {
    if (!sigue) return
    lista.current?.querySelector(`[data-pedido="${sigue}"]`)?.scrollIntoView({ block: "center" })
  }, [sigue, hecho])

  const hoy = all.flatMap((p) => p.pagos).filter((g) => g.quien === "Kevin" && g.cuando.startsWith("Hoy"))
  const de = (m: Medio[]) => hoy.filter((g) => m.includes(g.medio)).reduce((a, g) => a + g.monto, 0)
  const efectivo = de(["efectivo"])
  const vuelto = mias.filter((x) => x.paso !== "entregado").reduce((a, x) => a + vueltoDe(x), 0)

  const volver = () => setPantalla(null)
  const hacer: Hacer = (texto, ids, fn) => {
    const copias = all.filter((x) => ids.includes(x.id)).map((x) => structuredClone(x))
    fn()
    setPantalla(null)
    setHecho({ texto, copias, id: ids.length === 1 ? ids[0] : undefined })
  }
  const pid = pantalla && "id" in pantalla ? pantalla.id : null
  const p = pid ? all.find((x) => x.id === pid) : undefined

  return (
    <div className="relative flex h-full flex-col bg-muted/40" data-brand="gestoria">
      <div className="flex items-center gap-2 border-b bg-card px-4 py-3">
        <span className="flex-1">
          <b className="block text-[15px]">Hoy · jueves 27</b>
          <span className="text-xs text-muted-foreground">
            Kevin · {mias.length + 1} entregas{recojos.length ? ` y ${recojos.length} recojo` : ""}
            {agencias.length ? ` · ${agencias.length} a la agencia` : ""}
          </span>
        </span>
        <Badge variant="secondary">gestorIA Reparto</Badge>
      </div>
      {hecho ? (
        <div role="status" className="flex items-center gap-2 border-b bg-success-soft px-3 py-2">
          <Check className="size-5 shrink-0 text-success" aria-hidden />
          <span className="flex-1 text-[15px] font-medium">{hecho.texto}</span>
          <Button
            variant="outline"
            className="h-11 shrink-0"
            onClick={() => {
              reponer(rubro, hecho.copias)
              setHecho(null)
            }}
          >
            <Undo2 aria-hidden />
            Deshacer
          </Button>
        </div>
      ) : null}
      <div ref={lista} className="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
        <section className="flex flex-col gap-2">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <span className="size-3 rounded-full" style={{ background: R.store.color }} />
            {R.store.name}
            <span className="font-normal text-muted-foreground">· {mias.length + recojos.length + agencias.length}</span>
          </span>
          {porSalir.length ? (
            <div className="flex flex-col gap-2 rounded-xl border bg-card p-3">
              <span className="text-[15px]">
                <b>Por salir: {porSalir.length}</b>
                <span className="block text-sm text-muted-foreground">
                  {porSalir.map((x) => nombreCorto(x)).join(" · ")}
                </span>
              </span>
              {vuelto ? (
                <span className="flex items-center gap-2 text-sm">
                  <Banknote className="size-4 shrink-0" aria-hidden />
                  Sal con {money(vuelto)} en sencillo para los vueltos.
                </span>
              ) : null}
              <Button className="h-11" onClick={() => setPantalla({ t: "salir" })}>
                Salí con {porSalir.length === 1 ? "el" : `los ${porSalir.length}`}
              </Button>
            </div>
          ) : null}
          <ul className="flex flex-col gap-2">
            {recojos.map((x) => (
              <Tarjeta
                key={x.id}
                p={x}
                recojo
                siguiente={sigue === x.id}
                onAbrir={() => setPantalla({ t: "recoger", id: x.id })}
              />
            ))}
            {ruta.map((x) => (
              <Tarjeta
                key={x.id}
                p={x}
                siguiente={sigue === x.id}
                onAbrir={() => setPantalla({ t: "entregar", id: x.id })}
              />
            ))}
            {agencias.map((x) => (
              <li
                key={x.id}
                data-pedido={x.id}
                className="flex scroll-mt-16 flex-col gap-2 rounded-xl border bg-card p-3"
              >
                <span className="flex items-start gap-3">
                  <Package className="mt-0.5 size-6 shrink-0 text-muted-foreground" aria-hidden />
                  <span className="min-w-0 flex-1">
                    <b className="block text-[15px]">
                      {x.id} · {nombreCorto(x)}
                    </b>
                    <span className="text-sm text-muted-foreground">
                      Va a {x.entrega.zona.split(",")[0]} por {x.entrega.agencia ?? "agencia"}
                    </span>
                  </span>
                  <Badge variant="soft">Agencia</Badge>
                </span>
                <span className="text-sm font-medium">Lo dejas en la agencia de camino. No cobra.</span>
                <Button className="h-11" onClick={() => setPantalla({ t: "agencia", id: x.id })}>
                  Dejar en {x.entrega.agencia ?? "la agencia"}
                </Button>
              </li>
            ))}
            {mias.some((x) => x.paso === "preparando") ? (
              <li className="rounded-xl border border-dashed p-3 text-sm text-muted-foreground">
                {mias.filter((x) => x.paso === "preparando").length} más se están empacando en la tienda.
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
              <span className="text-xs text-muted-foreground">Miraflores · recoger desde las 4 p. m.</span>
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
          Efectivo {money(efectivo)} · POS {money(de(["pos"]))} · Yape o Plin {money(de(["yape", "plin"]))}
        </span>
      </div>
      {pantalla?.t === "salir" ? <Salir lista={porSalir} onVolver={volver} hacer={hacer} /> : null}
      {pantalla?.t === "entregar" && p ? (
        <Entregar
          key={p.id}
          p={p}
          onVolver={volver}
          onNo={() => setPantalla({ t: "no", id: p.id })}
          hacer={hacer}
        />
      ) : null}
      {pantalla?.t === "no" && p ? (
        <NoSeEntrego key={p.id} p={p} onVolver={() => setPantalla({ t: "entregar", id: p.id })} hacer={hacer} />
      ) : null}
      {pantalla?.t === "recoger" && p ? <Recoger key={p.id} p={p} onVolver={volver} hacer={hacer} /> : null}
      {pantalla?.t === "agencia" && p ? <Agencia key={p.id} p={p} onVolver={volver} hacer={hacer} /> : null}
    </div>
  )
}

/** La dirección con su distrito, sin repetirlo si ya viene en la dirección («…, Ate» no suma «Ate» otra vez). */
function conDistrito(direccion: string, zona: string): string {
  const distrito = zona.split(",")[0].trim()
  const sinTildes = (t: string) => t.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase()
  const dir = sinTildes(direccion)
  const corto: Record<string, string> = {
    "san juan de lurigancho": "sjl",
    "san juan de miraflores": "sjm",
    "villa el salvador": "ves",
  }
  const d = sinTildes(distrito)
  const sigla = corto[d]
  const palabras = dir.split(/[^a-z0-9]+/)
  if (dir.includes(d) || (sigla && palabras.includes(sigla))) return direccion
  return `${direccion}, ${distrito}`
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
        Kevin reparte para varias tiendas con una sola app, gestorIA Reparto. Cada acción abre su
        propia pantalla: ahí ve a quién, qué y cuánto, toma la foto y confirma con el botón de abajo.
        «Entregado» se activa solo con el pago confirmado. Prueba cobrarle a Lorena o recoger el par de
        Kiara.
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

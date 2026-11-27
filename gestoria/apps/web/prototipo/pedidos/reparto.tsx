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
import { useState } from "react"
import { RUBROS } from "../datos"
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

type Forma = "link" | "efectivo" | "yape" | "pos"

/** Cobrar en la puerta: cada forma con quien la confirma. «Entregué» solo con el pago confirmado. */
function Cobrar({ p, onClose }: { p: Pedido; onClose: () => void }) {
  const { rubro } = useRuta()
  const k = cuentas(p)
  const [forma, setForma] = useState<Forma | null>(null)
  const [recibi, setRecibi] = useState("")
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
                cobrar(
                  "efectivo",
                  "Kevin",
                  `Cobró ${money(k.falta)} en efectivo. Lo entrega en Caja.`,
                )
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
              onClick={() => {
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
              }}
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
          onClick={() => {
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
          }}
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
        {p.paso === "entregado" ? (
          <Badge variant="success">Entregado</Badge>
        ) : pagado ? (
          <Badge variant="success">Pagado</Badge>
        ) : (
          <Badge variant="warning">Cobrar {money(k.falta || k.porConfirmar)}</Badge>
        )}
      </span>
      {p.paso === "en_camino" ? (
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
            }
          >
            No estaba
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
  const [cobrando, setCobrando] = useState<string | null>(null)
  const mias = all.filter(
    (p) =>
      p.entrega.repartidor === "Kevin" &&
      p.entrega.dia === "Hoy" &&
      ["por_salir", "en_camino", "entregado", "preparando"].includes(p.paso),
  )
  const porSalir = mias.filter((p) => p.paso === "por_salir")
  const efectivo = all
    .flatMap((p) => p.pagos)
    .filter((g) => g.medio === "efectivo" && g.quien === "Kevin" && g.cuando.startsWith("Hoy"))
    .reduce((a, g) => a + g.monto, 0)
  const p = cobrando ? all.find((x) => x.id === cobrando) : undefined
  return (
    <div className="relative flex h-full flex-col bg-muted/40" data-brand="gestoria">
      <div className="flex items-center gap-2 border-b bg-card px-4 py-3">
        <span className="flex-1">
          <b className="block text-[15px]">Hoy · jueves 27</b>
          <span className="text-xs text-muted-foreground">
            Kevin · {mias.length + 1} entregas de 2 tiendas
          </span>
        </span>
        <Badge variant="secondary">gestorIA Reparto</Badge>
      </div>
      <div className="flex flex-1 flex-col gap-4 overflow-y-auto p-3">
        <section className="flex flex-col gap-2">
          <span className="flex items-center gap-2 text-sm font-semibold">
            <span className="size-3 rounded-full" style={{ background: R.store.color }} />
            {R.store.name}
            <span className="font-normal text-muted-foreground">· {mias.length}</span>
          </span>
          {porSalir.length ? (
            <Button
              onClick={() => {
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
              }}
            >
              Salí con {porSalir.length === 1 ? "el" : `los ${porSalir.length}`}
            </Button>
          ) : null}
          <ul className="flex flex-col gap-2">
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
      <div className="flex items-center justify-between border-t bg-card px-4 py-3 text-sm">
        <span className="text-muted-foreground">Mi plata hoy · efectivo</span>
        <b className="tabular-nums">{money(efectivo)}</b>
      </div>
      {p ? <Cobrar p={p} onClose={() => setCobrando(null)} /> : null}
    </div>
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

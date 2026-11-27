import {
  Badge,
  Button,
  cn,
  Popover,
  PopoverContent,
  PopoverTrigger,
  toast,
  useIsMobile,
} from "@odentia/ui"
import { AgentMark, PageHeader, PageShell, PersonAvatar } from "@odentia/ui-patterns"
import { ArrowLeft, Check, CircleAlert, CircleCheck, UserRoundX } from "lucide-react"
import { type ReactNode, useEffect, useRef, useState } from "react"
import { EncargoCard, enviosDe } from "./campanas"
import { ACC, encargoDe, foto, META, mensaje, nombre, perfil, RUBROS, SEG, soles } from "./datos"
import { cambiar, planOf, useDb } from "./estado"
import { SegBadge } from "./piezas"
import { ir, useRuta } from "./ruta"

type Key = "rocio" | "fio"
type Msg =
  | {
      k: "in" | "out"
      t: ReactNode
      h: string
      img?: string
      used?: string[]
      tag?: string
      botones?: string[]
    }
  | { k: "sys"; t: ReactNode; tone?: "ok" | "baja" | "aviso" }

const CHATS: Record<Key, { id: string; respuestas: string[] }> = {
  rocio: {
    id: "c5",
    respuestas: [
      "Sí, mándame",
      "ya, me gusta. ¿me la dejas en 120?",
      "ok, te yapeo",
      "[Captura del Yape] listo",
    ],
  },
  fio: { id: "c8", respuestas: ["ya no me mandes estas cosas porfa"] },
}

function useMsgs(key: Key): Msg[] {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const d = useDb(ruta.rubro)
  const c = d.cl.find((x) => x.id === CHATS[key].id)!
  const step = d.chat[key]
  const size = c.datos.talla?.valor ?? R.sizes[c.s] ?? ""
  const nv = R.nuevo
  const a = key === "rocio" ? "despertar" : "nuevo"
  const campana = `«${ACC[a].t(R)}»`
  const out: Msg[] = [
    {
      k: "sys",
      t: `Lun 23 · 16:00 · Sofi le escribió por la campaña ${campana}, con la plantilla «${ACC[a].tpl}»${ruta.ventas ? "" : ` · Meta ${soles(META)}`}`,
    },
    {
      k: "out",
      t: mensaje(a, c, R),
      h: "16:00",
      tag: `Sofi · campaña ${campana}`,
      botones: ["Sí, mándame", "Ahora no"],
    },
  ]
  if (key === "rocio") {
    if (step >= 1) {
      out.push({ k: "in", t: "Sí, mándame", h: "Vie 27 · 10:12" })
      out.push({
        k: "out",
        img: nv.photo,
        t: `Es ${nv.name.toLowerCase()} ${nv.color}, ${soles(nv.price)}. ${R.fit(size)
          .replace(/^en /, "En ")
          .replace(
            /^para /,
            "Para ",
          )} quedan 2. Te llega a ${c.dist} el sábado, con envío de S/ 10. ¿Te la separo?`,
        h: "10:12",
        used: [`${R.field}: ${size} (lo anotó Argos)`, `${c.dist} (su última entrega)`, "Stock: 2"],
      })
    }
    if (step >= 2) {
      out.push({ k: "in", t: "ya, me gusta. ¿me la dejas en 120?", h: "10:14" })
      out.push({
        k: "out",
        t: `A 120 no llego, pero te la dejo en ${soles(nv.price - 10)} si la pagas hoy antes de las 18:00. Con el envío, ${soles(nv.price)}.`,
        h: "10:14",
        used: [`El encargo: hasta ${soles(nv.price - 10)}, no menos`, "Una sola oferta, con plazo"],
      })
    }
    if (step >= 3) {
      out.push({ k: "in", t: "ok, te yapeo", h: "10:15" })
      out.push({
        k: "out",
        t: `Listo, Rocío. Tu pedido 0161: ${nv.name.toLowerCase()} ${nv.color} ${size}, ${soles(nv.price - 10)} + envío S/ 10 = ${soles(nv.price)}. Yapea al 987 654 321 y mándame la captura.`,
        h: "10:15",
      })
      out.push({ k: "sys", t: `Pedido 0161 · Venta de la campaña ${campana} · por pagar` })
    }
    if (step >= 4) {
      out.push({ k: "in", t: "[Captura del Yape] listo", h: "10:19" })
      out.push({ k: "out", t: "¡Gracias, Rocío! Ya revisamos tu pago y te aviso.", h: "10:19" })
      out.push(
        d.paid
          ? {
              k: "sys",
              tone: "ok",
              t: `Pago confirmado · Venta de la campaña ${campana}: ${soles(nv.price)} · Rocío pasó de Dormida a ${SEG[perfil(c).seg].label}`,
            }
          : {
              k: "sys",
              tone: "aviso",
              t: "Captura recibida: la confirma una persona del equipo. Hasta entonces, la venta está pendiente.",
            },
      )
    }
  } else if (step >= 1) {
    out.push({ k: "in", t: "ya no me mandes estas cosas porfa", h: "Vie 27 · 09:48" })
    out.push({
      k: "out",
      t: "Entendido, Fiorella. No te enviaremos más promociones. Los avisos de tus pedidos sí te seguirán llegando. Si algún día las quieres de nuevo, escríbeme «quiero promociones».",
      h: "09:48",
    })
    out.push({
      k: "sys",
      tone: "baja",
      t: "Sofi le confirmó y Argos anotó la baja en su ficha. Desde hoy, 09:48, no recibe promociones.",
    })
  }
  return out
}

/** Arriba del chat: por qué Sofi le escribió, con el encargo de Argos a la mano. */
function PorQue({ k }: { k: Key }) {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const d = useDb(ruta.rubro)
  const e = enviosDe(d, R, planOf(ruta.rubro)).find((x) => x.chat === k)
  if (!e) return null
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b bg-agent-soft/40 px-4 py-2 text-sm">
      <AgentMark size="sm" />
      <span className="min-w-0 flex-1">
        Sofi le escribe por la campaña <b>«{ACC[e.a].t(R)}»</b> · porque {e.motivo}
      </span>
      <Popover>
        <PopoverTrigger render={<Button variant="ghost" size="xs" />}>
          Ver el encargo
        </PopoverTrigger>
        <PopoverContent align="end" className="w-[min(30rem,calc(100vw-2rem))] p-0">
          <EncargoCard e={encargoDe(e.a, e.c, R, e.motivo)} className="border-0" />
        </PopoverContent>
      </Popover>
    </div>
  )
}

function Conversacion({ k, onBack }: { k: Key; onBack?: () => void }) {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const d = useDb(ruta.rubro)
  const c = d.cl.find((x) => x.id === CHATS[k].id)!
  const msgs = useMsgs(k)
  const step = d.chat[k]
  const next = CHATS[k].respuestas[step]
  const esperaPago = k === "rocio" && step >= 4 && !d.paid
  const caja = useRef<HTMLDivElement>(null)
  // Lo último que se dijo queda a la vista, como en un chat.
  useEffect(() => {
    const el = caja.current
    if (el && msgs.length) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" })
  }, [msgs.length])
  const decir = () =>
    cambiar(ruta.rubro, (x) => {
      x.chat[k] += 1
      const n = x.chat[k]
      if (k === "rocio" && n === 1) x.extra.despertar = { r: 1, k: 1, c: 0, v: 0, b: 0 }
      if (k === "fio" && n === 1) {
        const f = x.cl.find((y) => y.id === "c8")
        if (f)
          f.consent = {
            estado: "baja",
            nota: "Lo pidió en el chat el 27 nov, 09:48: «ya no me mandes estas cosas porfa». Solo vuelve si ella lo pide.",
          }
        x.extra.nuevo = { r: 1, k: 0, c: 0, v: 0, b: 1 }
      }
    })
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-3 border-b px-4 py-3">
        {onBack ? (
          <Button
            variant="ghost"
            size="icon"
            aria-label="Volver a las conversaciones"
            onClick={onBack}
          >
            <ArrowLeft aria-hidden />
          </Button>
        ) : null}
        <PersonAvatar name={c.name} className="size-9" decorative />
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="truncate font-semibold">{c.name}</span>
          <span className="text-xs text-muted-foreground">WhatsApp · atiende Sofi</span>
        </span>
        <SegBadge seg={perfil(c).seg} />
        <Button variant="outline" size="sm" onClick={() => ir(`/clientes/${c.id}`)}>
          Ficha
        </Button>
      </div>
      <PorQue k={k} />
      <div
        ref={caja}
        className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto bg-surface-muted/40 px-4 py-4"
        aria-live="polite"
      >
        {msgs.map((m, i) =>
          m.k === "sys" ? (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: los mensajes solo se agregan al final
              key={i}
              className={cn(
                "entra flex max-w-[92%] items-center gap-2 self-center rounded-2xl px-3 py-1.5 text-center text-xs font-medium",
                m.tone === "ok"
                  ? "bg-success-soft text-success"
                  : m.tone === "baja"
                    ? "bg-danger-soft text-destructive"
                    : "bg-warning-soft text-warning",
              )}
            >
              {m.tone === "ok" ? (
                <CircleCheck className="size-3.5 shrink-0" aria-hidden />
              ) : m.tone === "baja" ? (
                <UserRoundX className="size-3.5 shrink-0" aria-hidden />
              ) : (
                <CircleAlert className="size-3.5 shrink-0" aria-hidden />
              )}
              <span>{m.t}</span>
            </div>
          ) : (
            <div
              // biome-ignore lint/suspicious/noArrayIndexKey: los mensajes solo se agregan al final
              key={i}
              className={cn(
                "entra flex max-w-[85%] flex-col gap-1",
                m.k === "out" ? "items-end self-end" : "self-start",
              )}
            >
              <div
                className={cn(
                  "rounded-2xl px-3.5 py-2.5 text-sm leading-relaxed",
                  m.k === "out"
                    ? "rounded-br-md border border-agent-border bg-agent-soft"
                    : "rounded-bl-md bg-card shadow-xs",
                )}
              >
                {m.tag ? (
                  <span className="mb-1 block text-[11px] font-semibold text-muted-foreground">
                    {m.tag}
                  </span>
                ) : null}
                {m.img ? (
                  <img
                    src={foto(m.img)}
                    alt=""
                    className="mb-2 aspect-[4/3] w-56 rounded-xl object-cover"
                  />
                ) : null}
                {m.t}
                {m.botones ? (
                  <span className="mt-2 flex gap-1.5">
                    {m.botones.map((b) => (
                      <span
                        key={b}
                        className="flex-1 rounded-lg bg-card px-2 py-1.5 text-center text-[13px] font-medium text-primary shadow-xs"
                      >
                        {b}
                      </span>
                    ))}
                  </span>
                ) : null}
                <span className="ml-2 align-bottom text-[11px] text-muted-foreground">{m.h}</span>
              </div>
              {m.used ? (
                <div
                  className="flex flex-wrap justify-end gap-1"
                  role="group"
                  aria-label="Lo que usó Sofi"
                >
                  {m.used.map((u) => (
                    <span
                      key={u}
                      className="inline-flex h-6 items-center gap-1 rounded-full border bg-card px-2 text-[11px] font-medium text-muted-foreground"
                    >
                      <Check className="size-3 text-success" aria-hidden />
                      {u}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
          ),
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2 border-t bg-card p-3">
        {esperaPago ? (
          <>
            <span className="w-full text-xs font-medium text-muted-foreground">
              Lo confirma una persona del equipo
            </span>
            <Button
              onClick={() => {
                cambiar(ruta.rubro, (x) => {
                  x.paid = true
                  const r = x.cl.find((y) => y.id === "c5")
                  if (r)
                    r.buys.push({
                      d: 0,
                      p: { ...R.nuevo },
                      size: r.datos.talla?.valor ?? R.sizes[r.s] ?? "",
                      price: R.nuevo.price - 10,
                      reb: true,
                      liq: false,
                      argos: "despertar",
                      pedido: "0161",
                      motivo: "no compraba hace 140 días",
                    })
                  x.extra.despertar = { r: 1, k: 1, c: 1, v: R.nuevo.price, b: 0 }
                })
                toast.success(`Pago confirmado. Suma en la campaña «${ACC.despertar.t(R)}».`)
              }}
            >
              Confirmar el pago de S/ {R.nuevo.price}
            </Button>
          </>
        ) : next ? (
          <>
            <span className="w-full text-xs font-medium text-muted-foreground">
              Prototipo · responde como {nombre(c)}
            </span>
            <Button
              variant="outline"
              className="h-auto min-h-9 whitespace-normal border-dashed text-left"
              onClick={decir}
            >
              {next}
            </Button>
          </>
        ) : (
          <>
            <span className="w-full text-xs font-medium text-muted-foreground">
              Fin del ejemplo
            </span>
            <Button
              variant="outline"
              onClick={() =>
                cambiar(ruta.rubro, (x) => {
                  x.chat[k] = 0
                  if (k === "fio") {
                    const f = x.cl.find((y) => y.id === "c8")
                    if (f) f.consent = { estado: "si", nota: "Aceptó en su primera compra" }
                    delete x.extra.nuevo
                  } else {
                    x.paid = false
                    const r = x.cl.find((y) => y.id === "c5")
                    if (r) r.buys = r.buys.filter((b) => !b.argos)
                    delete x.extra.despertar
                  }
                })
              }
            >
              Ver de nuevo
            </Button>
          </>
        )}
      </div>
    </div>
  )
}

/** Las conversaciones: cuando Sofi escribe por una campaña de Argos y la clienta responde. */
export function ConversacionesPage({ inicial }: { inicial?: Key }) {
  const ruta = useRuta()
  const R = RUBROS[ruta.rubro]
  const d = useDb(ruta.rubro)
  const isMobile = useIsMobile()
  const [sel, setSel] = useState<Key | null>(inicial ?? (isMobile ? null : "rocio"))
  const items: [Key, string, string][] = [
    [
      "rocio",
      "c5",
      d.chat.rocio
        ? d.paid
          ? "Pedido 0161 pagado"
          : "Le respondió a Sofi"
        : `Sofi: «${ACC.despertar.t(R)}»`,
    ],
    ["fio", "c8", d.chat.fio ? "Pidió no recibir promociones" : `Sofi: «${ACC.nuevo.t(R)}»`],
  ]
  const list = (
    <ul className="flex flex-col divide-y">
      {items.map(([k, id, last]) => {
        const c = d.cl.find((x) => x.id === id)!
        return (
          <li key={k}>
            <button
              type="button"
              onClick={() => setSel(k)}
              className={cn(
                "flex w-full items-center gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/60",
                sel === k && "bg-primary-soft/50",
              )}
            >
              <PersonAvatar name={c.name} className="size-10" decorative />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="flex items-center gap-2">
                  <span className="truncate font-medium">{c.name}</span>
                  {k === "rocio" && d.chat.rocio >= 4 && !d.paid ? (
                    <Badge variant="warning">Pago</Badge>
                  ) : null}
                </span>
                <span className="truncate text-sm text-muted-foreground">{last}</span>
              </span>
            </button>
          </li>
        )
      })}
    </ul>
  )
  return (
    <PageShell className="flex flex-col gap-5">
      {isMobile && sel ? null : (
        <PageHeader
          title="Conversaciones"
          subtitle="Sofi escribe por las campañas de Argos y sigue la conversación hasta vender."
        />
      )}
      {isMobile ? (
        sel ? (
          <div className="-m-4 h-[calc(100dvh)] bg-card">
            <Conversacion k={sel} onBack={() => setSel(null)} />
          </div>
        ) : (
          <div className="elevated overflow-hidden rounded-xl border bg-card">{list}</div>
        )
      ) : (
        <div className="elevated grid h-[calc(100svh-var(--notice-strip-h,0px)-9rem)] min-h-[34rem] grid-cols-[20rem_minmax(0,1fr)] overflow-hidden rounded-xl border bg-card">
          <div className="flex min-h-0 flex-col border-r">
            <div className="flex items-center gap-2 border-b px-4 py-3 text-sm text-muted-foreground">
              Los dos chats de ejemplo
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">{list}</div>
          </div>
          {sel ? <Conversacion key={sel} k={sel} /> : null}
        </div>
      )}
    </PageShell>
  )
}

import { Badge, Button, cn, toast } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { Textarea } from "@odentia/ui/components/textarea"
import {
  FormPanel,
  PageHeader,
  PageShell,
  RadioChips,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { Hoja } from "./hoja"
import { ArrowLeft, Check, Clock3, RotateCcw, ScrollText, Sparkles } from "lucide-react"
import { useState } from "react"
import { foto, RUBROS } from "../datos"
import { href, ir, useRuta } from "../ruta"
import { money, type Pedido, pedidosDe, usePedidos } from "./modelo"
import {
  aprobar,
  armar,
  CUANDO,
  cambiarCasilla,
  DINERO,
  ENVIO,
  guardarPolitica,
  lineasPolitica,
  llego,
  MOTIVO,
  NO_CAMBIA,
  type NoCambia,
  type Politica,
  pasosVuelta,
  RECOMENDADA,
  REVISION,
  rechazar,
  revisar,
  SIN_STOCK,
  useCasilla,
  usePolitica,
} from "./vuelta"

const nom = (p: Pedido) => p.clienta.split(" ")[0]!

/** La casilla de Configuración › Sofi, tal como está. En el prototipo se puede probar aquí. */
export function CasillaSofi({ compacta }: { compacta?: boolean }) {
  const { rubro } = useRuta()
  const on = useCasilla()
  return (
    <label className={cn("flex items-start gap-3 rounded-xl border p-3 text-sm", compacta && "p-2.5")}>
      <Switch
        checked={on}
        onCheckedChange={(v) => {
          cambiarCasilla(rubro, !!v)
          toast.success(
            v
              ? "Marcada: Sofi te pasa los cambios y las devoluciones, listos para aprobar."
              : "Desmarcada: Sofi hace sola lo que está dentro de tu política.",
          )
        }}
        className="mt-0.5"
      />
      <span className="flex flex-col gap-0.5">
        <span className="font-medium">
          Configuración › Sofi: «Sofi te pasa el chat cuando… es un reclamo, un cambio o una
          devolución»
        </span>
        <span className="text-xs text-muted-foreground">
          {on
            ? "Marcada (viene así). Sofi arma el caso según tu política y te lo pasa para aprobarlo con un toque, sin dejar de contestar."
            : "Desmarcada. Sofi hace sola lo que está dentro de tu política y solo te pasa lo que queda fuera."}
        </span>
      </span>
    </label>
  )
}

/** Los pasos de la vuelta, a lo ancho, como los del pedido. */
function PasosVuelta({ p }: { p: Pedido }) {
  const all = usePedidos(useRuta().rubro)
  const v = p.vuelta!
  const enl = v.enlazado ? all.find((x) => x.id === v.enlazado) : undefined
  const pasos = pasosVuelta(p, enl)
  const at = pasos.findIndex((s) => !s.h)
  return (
    <div className="-mx-1 overflow-x-auto px-1 pb-1">
      <ol
        className="grid gap-1.5"
        style={{ gridTemplateColumns: "repeat(5, minmax(0, 1fr))", minWidth: "30rem" }}
        aria-label={`Pasos ${v.tipo === "cambio" ? "del cambio" : "de la devolución"}`}
      >
        {pasos.map((s, i) => {
          const done = !!s.h
          const now = i === at && v.estado !== "rechazado"
          return (
            <li
              key={s.k}
              className={cn(
                "flex min-w-0 flex-col gap-1.5 rounded-xl border p-2.5 text-xs",
                now && "border-primary bg-primary-soft/40",
                !done && !now && "border-dashed",
              )}
              aria-current={now ? "step" : undefined}
            >
              <span className="flex items-center gap-1.5">
                <span
                  className={cn(
                    "flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-semibold",
                    done ? "bg-success text-white" : now ? "bg-primary text-primary-foreground" : "border text-muted-foreground",
                  )}
                  aria-hidden
                >
                  {done ? <Check className="size-3" /> : i + 1}
                </span>
                <span className={cn("text-[13px] leading-tight font-semibold", !done && !now && "font-medium text-muted-foreground")}>
                  {s.l}
                </span>
              </span>
              <span className="leading-snug text-muted-foreground">
                {done ? (
                  <>
                    <b className="font-medium text-foreground">{s.h!.quien}</b>
                    <span className="block">{s.h!.cuando}</span>
                    {s.h!.texto && s.h!.texto !== s.l ? <span className="block">{s.h!.texto}</span> : null}
                  </>
                ) : v.estado === "rechazado" ? (
                  "—"
                ) : (
                  <>
                    {now ? "Ahora: " : "Falta: "}
                    <b className="font-medium text-foreground">{s.falta.quien}</b>
                    {s.falta.cuando ? <span className="block">{s.falta.cuando}</span> : null}
                  </>
                )}
              </span>
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** El pedido de cambio o devolución, enlazado al entregado, con sus pasos y lo que acordó Sofi. */
export function VueltaBloque({ p }: { p: Pedido }) {
  const { rubro } = useRuta()
  const pol = usePolitica(rubro)
  const v = p.vuelta
  if (!v) return null
  const a = v.arm
  const n = nom(p)
  const titulo = v.tipo === "cambio" ? (v.motivo === "falla" ? "Cambio por falla" : "Cambio") : "Devolución"
  const estado =
    v.estado === "solicitado"
      ? a.dentro
        ? "Por aprobar"
        : "Fuera de tu política"
      : v.estado === "rechazado"
        ? "No se hizo"
        : v.estado === "cerrado"
          ? "Terminado"
          : v.estado === "recibido"
            ? "Por revisar"
            : v.estado === "revisado"
              ? "Revisado"
              : "Aprobado"
  const filas: [string, string][] = [
    ["Por qué", `${MOTIVO[v.motivo]}${v.foto ? " · mandó foto" : ""} · «${v.dice}»`],
    [
      "Política",
      a.fuera
        ? `${a.fuera}.${v.excepcion ? ` Excepción: «${v.excepcion}».` : ""}`
        : v.motivo === "falla"
          ? `Dentro de la garantía: ${v.dias} días de ${a.plazo}.`
          : `Dentro: ${v.dias} días de ${a.plazo}.`,
    ],
    ["Vuelve", v.vuelven.map((l) => `${l.nombre} ${l.variante} (${money(l.precio * l.qty)})`).join(", ") + (v.vuelven.length < p.lineas.length ? ` · ${v.vuelven.length} de ${p.lineas.length}` : "")],
  ]
  if (v.sale) filas.push(["Sale", `${v.sale.nombre} ${v.sale.variante} (${money(v.sale.precio)})${v.enlazado ? ` · pedido ${v.enlazado}` : ""}`])
  if (v.sinStock) filas.push(["Sin stock", `No había ${v.sinStock}. Sofi ofreció, en orden: ${SIN_STOCK[pol.sinStock].toLowerCase()}.`])
  if (a.diferencia > 0) filas.push(["Diferencia", `${money(a.diferencia)} · Sofi la cobra con su link`])
  if (a.monto)
    filas.push([
      a.dinero === "saldo" ? "A su favor" : "Se le devuelve",
      `${money(a.monto)} · ${a.dinero === "saldo" ? "saldo a favor para su próxima compra" : `por ${v.medio === "link" || v.medio === "pos" ? "la pasarela" : v.medio === "plin" ? "Plin" : "Yape"}, ${CUANDO[a.cuandoDinero].toLowerCase()}`}`,
    ])
  filas.push([
    "Cómo vuelve",
    v.como === "recojo_mismo"
      ? `${v.repartidor ?? "Kevin"} lo recoge en el mismo viaje del cambio`
      : v.como === "recojo_solo"
        ? `${v.repartidor ?? "Kevin"} lo recoge (un viaje solo para recoger)`
        : v.como === "tienda"
          ? `${n} lo trae a la tienda`
          : `Por ${v.agencia?.nombre} desde ${v.agencia?.ciudad}${v.agencia?.numero ? `, N.º ${v.agencia.numero}` : ""}`,
  ])
  filas.push(["Envío de vuelta", a.envioPaga === "tienda" ? "Lo pone la tienda" : `Lo paga ${n} (${money(a.envio)})`])
  if (v.revision)
    filas.push(["Revisión", `${REVISION[v.revision.k].label}${v.revision.motivo ? ` · ${v.revision.motivo}` : ""}. ${REVISION[v.revision.k].kardex}`])
  return (
    <section
      aria-labelledby="vuelta-h"
      className="elevated flex min-w-0 flex-col gap-3 rounded-xl border border-primary/40 bg-card p-4"
    >
      <div className="flex flex-wrap items-center gap-2">
        <RotateCcw className="size-4 text-primary" aria-hidden />
        <h2 id="vuelta-h" className="font-heading text-base font-semibold">
          {titulo} {v.id}
        </h2>
        <Badge variant={estado === "Terminado" ? "success" : estado === "Fuera de tu política" || estado === "No se hizo" ? "outline" : "warning"}>
          {estado}
        </Badge>
        {v.enlazado ? (
          <a href={href(`/pedidos/${v.enlazado}`)} className="text-sm font-medium text-primary hover:underline">
            Pedido del cambio {v.enlazado}
          </a>
        ) : null}
      </div>
      <PasosVuelta p={p} />
      <dl className="flex flex-col divide-y rounded-xl border text-sm">
        {filas.map(([k, val]) => (
          <div key={k} className="flex flex-col gap-0.5 px-3 py-2 sm:flex-row sm:gap-3">
            <dt className="shrink-0 text-muted-foreground sm:w-32">{k}</dt>
            <dd className="min-w-0">{val}</dd>
          </div>
        ))}
      </dl>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
        <Sparkles className="size-3.5 text-primary" aria-hidden />
        Sofi lo armó según tu política: {ENVIO[pol.envio].toLowerCase()} paga el envío de vuelta,{" "}
        {DINERO[pol.dinero].toLowerCase()}.
        <a href={href("/pedidos/politica")} className="font-medium text-primary hover:underline">
          Según tu política de cambios y devoluciones
        </a>
      </p>
    </section>
  )
}

/** Solo en el prototipo: lo que haría la clienta, la agencia o el repartidor con la vuelta. */
export function SimularVuelta({ p }: { p: Pedido }) {
  const { rubro } = useRuta()
  const v = p.vuelta
  if (!v) return null
  const opts: [string, () => void][] = []
  if (v.estado === "aprobado" && v.como === "tienda") opts.push([`${nom(p)} lo trae a la tienda`, () => llego(rubro, p)])
  if (v.estado === "aprobado" && v.como === "agencia") opts.push([`Llega por ${v.agencia?.nombre}`, () => llego(rubro, p)])
  if (v.estado === "aprobado" && v.como.startsWith("recojo"))
    opts.push([`Abrir la app de ${v.repartidor ?? "Kevin"}: «Recoger»`, () => ir("/reparto")])
  return (
    <div className="propuesta flex flex-col gap-2 rounded-xl border p-3">
      <span className="text-xs font-semibold text-muted-foreground">
        Prototipo · el cambio o la devolución
      </span>
      {opts.length ? (
        <div className="flex flex-wrap gap-2">
          {opts.map(([l, f]) => (
            <Button key={l} size="sm" variant="outline" onClick={f}>
              <Clock3 aria-hidden />
              {l}
            </Button>
          ))}
        </div>
      ) : null}
      <CasillaSofi compacta />
    </div>
  )
}

/* ---------- Los cajones: revisar lo que volvió y decidir la excepción ---------- */

export function RevisarDrawer({ p, onClose }: { p: Pedido; onClose: () => void }) {
  const { rubro } = useRuta()
  const v = p.vuelta!
  const [k, setK] = useState<keyof typeof REVISION | null>(v.motivo === "falla" ? "garantia" : "vender")
  const [motivo, setMotivo] = useState(v.motivo === "falla" ? "Suela despegada en el talón; foto de Kevin." : "")
  const falta = k !== "vender" && !motivo.trim()
  const a = v.arm
  const sigue =
    a.monto && a.dinero === "saldo"
      ? `gestorIA deja ${money(a.monto)} a favor de ${nom(p)} y Sofi se lo dice. No hay nada más que tocar.`
      : a.monto
        ? v.medio === "link" || v.medio === "pos"
          ? `Después apruebas devolverle ${money(a.monto)}: la pasarela lo hace sola.`
          : `Después le devuelves ${money(a.monto)} por ${v.medio === "plin" ? "Plin" : "Yape"} desde tu app y tocas «Ya lo devolví».`
        : "Se cierra. Sofi le avisa."
  return (
    <Hoja
      open
      onClose={onClose}
      title={`Revisar lo que volvió · ${p.id}`}
      description="Lo que se puede vender vuelve al stock. Lo dañado o en garantía no vuelve."
      submitLabel="Guardar la revisión"
      submitDisabled={!k || falta}
      onSubmit={(e) => {
        e.preventDefault()
        if (!k) return
        revisar(rubro, p, "Rosa", k, motivo.trim())
        toast.success(REVISION[k].kardex)
        onClose()
      }}
    >
      <div className="flex flex-col gap-2 rounded-xl border p-3 text-sm">
        {v.vuelven.map((l) => (
          <span key={l.id} className="flex items-center gap-3">
            {l.foto ? <img src={foto(l.foto)} alt="" className="size-10 rounded-lg object-cover" /> : null}
            <span className="min-w-0 flex-1">
              <b>{l.nombre}</b> · {l.variante}
            </span>
          </span>
        ))}
        <span className="text-xs text-muted-foreground">
          Motivo: {MOTIVO[v.motivo].toLowerCase()} · {v.hechos.vuelve?.quien ?? "—"} dejó la foto de cómo llegó.
        </span>
      </div>
      <div className="flex flex-col gap-2">
        <span id="rev-l" className="text-sm font-medium">
          ¿Cómo está?
        </span>
        <RadioChips
          aria-labelledby="rev-l"
          value={k}
          options={(Object.keys(REVISION) as (keyof typeof REVISION)[]).map((x) => ({
            value: x,
            label: REVISION[x].label,
          }))}
          onChange={setK}
        />
        {k ? <p className="text-xs text-muted-foreground">{REVISION[k].kardex}</p> : null}
      </div>
      {k !== "vender" ? (
        <div className="flex flex-col gap-2">
          <label htmlFor="rev-m" className="text-sm font-medium">
            El motivo
          </label>
          <Textarea id="rev-m" value={motivo} onChange={(e) => setMotivo(e.target.value)} rows={2} />
          <p className="text-xs text-muted-foreground">Queda en el kardex y en el pedido.</p>
        </div>
      ) : null}
      <p className="rounded-xl bg-muted px-3 py-2 text-sm">{sigue}</p>
    </Hoja>
  )
}

export function ExcepcionDrawer({ p, onClose }: { p: Pedido; onClose: () => void }) {
  const { rubro } = useRuta()
  const v = p.vuelta!
  const [que, setQue] = useState<"si" | "no" | null>(null)
  const [motivo, setMotivo] = useState("")
  return (
    <Hoja
      open
      onClose={onClose}
      title={`Fuera de tu política · ${p.id}`}
      description={`${v.arm.fuera}. Sofi ya se lo explicó a ${nom(p)} y siguió atendiéndola; ${nom(p)} insiste.`}
      submitLabel={que === "si" ? "Aprobar la excepción" : que === "no" ? "No hacer la excepción" : "Decidir"}
      submitDisabled={!que || !motivo.trim()}
      onSubmit={(e) => {
        e.preventDefault()
        if (que === "si") aprobar(rubro, p, "Rosa", motivo.trim())
        else rechazar(rubro, p, "Rosa", motivo.trim())
        toast.success(`Listo. Sofi se lo dijo a ${nom(p)}.`)
        onClose()
      }}
    >
      <div className="flex flex-col gap-1.5 rounded-xl border p-3 text-sm">
        <b>Lo que pidió</b>
        <span>{v.arm.tarjeta}</span>
        <span className="rounded-lg bg-muted px-3 py-2 text-[13px]">«{v.dice}»</span>
      </div>
      <div className="flex flex-col gap-2">
        <span id="exc-l" className="text-sm font-medium">
          ¿Haces una excepción?
        </span>
        <RadioChips
          aria-labelledby="exc-l"
          value={que}
          options={[
            { value: "si", label: "Sí, esta vez" },
            { value: "no", label: "No" },
          ]}
          onChange={setQue}
        />
      </div>
      <div className="flex flex-col gap-2">
        <label htmlFor="exc-m" className="text-sm font-medium">
          El motivo
        </label>
        <Textarea
          id="exc-m"
          value={motivo}
          onChange={(e) => setMotivo(e.target.value)}
          rows={2}
          placeholder={que === "no" ? "Pasó el plazo y ya tuvo uso." : "Clienta frecuente; solo las usó en casa."}
        />
        <p className="text-xs text-muted-foreground">
          Queda anotado en el pedido. Sofi le comunica a {nom(p)} lo que decidas, con amabilidad.
        </p>
      </div>
    </Hoja>
  )
}

/* ---------- Lo que ve la clienta en su link ---------- */

export function VueltaClienta({ p }: { p: Pedido }) {
  const { rubro } = useRuta()
  const all = usePedidos(rubro)
  const pol = usePolitica(rubro)
  const v = p.vuelta
  if (!v) return null
  const pasos = pasosVuelta(p, v.enlazado ? all.find((x) => x.id === v.enlazado) : undefined)
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8, padding: 12, border: "1px solid var(--vv-line, #e5e7eb)", borderRadius: 14 }}>
      <b style={{ fontSize: 15 }}>Tu {v.tipo === "cambio" ? "cambio" : "devolución"}</b>
      <ol style={{ display: "flex", flexDirection: "column", gap: 6, margin: 0, padding: 0, listStyle: "none" }}>
        {pasos.map((s) => (
          <li key={s.k} style={{ display: "flex", gap: 8, alignItems: "flex-start", fontSize: 13 }}>
            <span
              aria-hidden
              style={{
                width: 18,
                height: 18,
                flexShrink: 0,
                borderRadius: 99,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                background: s.h ? "var(--color-success, #16a34a)" : "transparent",
                border: s.h ? "none" : "1px dashed #94a3b8",
                color: "#fff",
                fontSize: 11,
              }}
            >
              {s.h ? "✓" : ""}
            </span>
            <span>
              <b style={{ fontWeight: 600 }}>{s.l}</b>
              <span style={{ display: "block", color: "var(--vv-ink-2, #64748b)" }}>
                {s.h ? s.h.cuando : s.falta.cuando || "Pronto"}
              </span>
            </span>
          </li>
        ))}
      </ol>
      <details style={{ fontSize: 12, color: "var(--vv-ink-2, #64748b)" }}>
        <summary style={{ cursor: "pointer", fontWeight: 600 }}>Política de cambios de {RUBROS[rubro].store.name}</summary>
        <ul style={{ margin: "6px 0 0 16px", padding: 0 }}>
          {lineasPolitica(rubro, pol).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </details>
    </div>
  )
}

/* ---------- Lo que aprende gestorIA: los motivos se cuentan ---------- */

export function LoQueAprende({ list }: { list: Pedido[] }) {
  const vueltas = list.filter((p) => p.vuelta)
  const entregados = list.filter((p) => p.paso === "entregado" && !p.cambioDe).length
  const cuenta = new Map<string, number>()
  for (const p of vueltas) cuenta.set(MOTIVO[p.vuelta!.motivo], (cuenta.get(MOTIVO[p.vuelta!.motivo]) ?? 0) + 1)
  const chico = list.find((p) => p.vuelta?.motivo === "chica")?.lineas[0]
  return (
    <section aria-labelledby="aprende-h" className="elevated flex flex-col gap-2 rounded-xl border bg-card p-4 text-sm">
      <h2 id="aprende-h" className="flex flex-wrap items-center gap-2 font-semibold">
        Lo que aprende gestorIA
        <span className="font-normal text-muted-foreground">
          {vueltas.length} de {entregados} entregados volvieron este mes ({Math.round((vueltas.length / Math.max(1, entregados)) * 100)} %)
        </span>
      </h2>
      <div className="flex flex-wrap gap-1.5">
        {[...cuenta.entries()]
          .sort((a, b) => b[1] - a[1])
          .map(([m, c]) => (
            <Badge key={m} variant="outline">
              {m} · {c}
            </Badge>
          ))}
      </div>
      {chico ? (
        <p className="text-muted-foreground">
          <Sparkles className="mr-1 inline size-3.5 text-primary" aria-hidden />
          {chico.nombre}: 3 de 4 cambios fueron porque le quedó chica. Sofi ya lo dice al venderla:
          «calza pequeño: pide una talla más». Reportes muestra la tasa con sus motivos.
        </p>
      ) : null}
    </section>
  )
}

/* ---------- La política de cambios y devoluciones ---------- */

const PLAZOS = ["3", "7", "15", "30"].map((d) => ({ value: d, label: `${d} días` }))

function Linea({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex items-center justify-between gap-3 py-1.5 text-sm">
      <span>{label}</span>
      {children}
    </label>
  )
}

/** Lo que diría Sofi con esta política, en tres casos de hoy. Cambia al tocar el formulario. */
function AsiLoDice({ pol }: { pol: Politica }) {
  const { rubro } = useRuta()
  const all = pedidosDe(rubro)
  const casos = ["0147", "0138", "0143"]
    .map((id) => all.find((p) => p.id === id))
    .filter((p): p is Pedido => !!p?.vuelta)
  const que = ["Quién paga el envío", "El plazo", "Cómo vuelve el dinero"]
  return (
    <section aria-labelledby="asi-h" className="elevated flex min-w-0 flex-col gap-3 rounded-xl border bg-card p-4">
      <h2 id="asi-h" className="flex items-center gap-2 text-base font-semibold">
        <Sparkles className="size-4 text-primary" aria-hidden />
        Así lo dice Sofi con esta política
      </h2>
      <p className="text-xs text-muted-foreground">
        Tres casos de hoy. Cambia algo a la izquierda y mira cómo cambia lo que dice Sofi y si el caso
        queda dentro o fuera.
      </p>
      <ul className="flex flex-col gap-3">
        {casos.map((p, i) => {
          const v = p.vuelta!
          const a = armar(rubro, p, { ...v, quiere: v.id === "C-0143" ? undefined : v.quiere }, pol)
          return (
            <li key={p.id} className="flex flex-col gap-1.5 text-sm">
              <span className="flex flex-wrap items-center gap-2 text-xs">
                <b>{que[i]}</b>
                <span className="text-muted-foreground">
                  {p.id} · {p.clienta} · «{v.dice}»
                </span>
                <Badge variant={a.dentro ? "success" : "outline"}>{a.dentro ? "Dentro" : a.fuera}</Badge>
              </span>
              <span className="self-start rounded-2xl rounded-tl-sm bg-primary-soft px-3 py-1.5 text-[13px] text-primary-soft-foreground">
                {a.sofi}
              </span>
            </li>
          )
        })}
      </ul>
      <div className="flex flex-col gap-1 border-t pt-3 text-xs text-muted-foreground">
        <b className="text-foreground">Lo que ve la clienta en su link y en la vitrina</b>
        <ul className="ml-4 list-disc">
          {lineasPolitica(rubro, pol).map((l) => (
            <li key={l}>{l}</li>
          ))}
        </ul>
      </div>
    </section>
  )
}

export function PoliticaPage() {
  const { rubro } = useRuta()
  const R = RUBROS[rubro]
  const guardada = usePolitica(rubro)
  const [vista, setVista] = useState<Politica>(guardada)
  const form = useAppForm({
    defaultValues: guardada,
    // Lo que dice Sofi a la derecha cambia mientras se edita, antes de guardar.
    listeners: { onChange: ({ formApi }) => setVista({ ...(formApi.state.values as Politica) }) },
    onSubmit: async ({ value }) => {
      guardarPolitica(rubro, value)
      toast.success("Guardada. Sofi ya la usa y los casos por aprobar se rearmaron.")
      form.reset(value)
    },
  })
  const surface = useFormSurface(form)
  const sw = (k: keyof Politica, label: string) => (
    <form.AppField name={k}>
      {(f) => (
        <Linea label={label}>
          <Switch
            checked={!!f.state.value}
            onCheckedChange={(v) => {
              f.handleChange(!!v as never)
            }}
          />
        </Linea>
      )}
    </form.AppField>
  )
  const sel = (k: keyof Politica, label: string, options: { value: string; label: string }[], help?: string) => (
    <form.AppField
      name={k}
    >
      {(f) => <f.SelectField label={label} description={help} options={options} />}
    </form.AppField>
  )
  const chips = (k: keyof Politica, label: string, options: { value: string; label: string }[], help?: string) => (
    <form.AppField name={k}>
      {(f) => (
        <f.Control label={label} description={help}>
          {(c) => (
            <RadioChips
              id={c.id}
              aria-label={label}
              aria-describedby={c.describedBy}
              value={String(f.state.value)}
              options={options}
              onChange={(v) => {
                f.handleChange(v as never)
              }}
            />
          )}
        </f.Control>
      )}
    </form.AppField>
  )
  const grupo = (t: string, children: React.ReactNode) => (
    <fieldset className="flex flex-col gap-3 border-t pt-4 first:border-t-0 first:pt-0">
      <legend className="mb-1 text-sm font-semibold">{t}</legend>
      {children}
    </fieldset>
  )
  return (
    <PageShell className="flex min-w-0 flex-col gap-4">
      <a
        href={href("/pedidos")}
        className="inline-flex items-center gap-1 self-start rounded-md text-sm font-medium text-primary hover:underline"
      >
        <ArrowLeft className="size-4" aria-hidden />
        Volver a Pedidos
      </a>
      <PageHeader
        title="Política de cambios y devoluciones"
        subtitle={`${R.store.name} · parte de la recomendada para ${R.label}. Sofi la sigue, la informa con sus palabras y no inventa nada fuera de ella.`}
      />
      <div className="grid min-w-0 items-start gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,30rem)]">
        <FormPanel
          {...surface}
          title="Tu política"
          description={`Viene con la recomendada para ${R.label}. Cámbiala como trabaja tu tienda.`}
          onClose={() => ir("/pedidos")}
          submitLabel="Guardar la política"
          className="elevated h-auto rounded-xl border"
          secondaryAction={{
            label: "Volver a la recomendada",
            onClick: () => {
              form.reset(RECOMENDADA[rubro], { keepDefaultValues: true })
              setVista(RECOMENDADA[rubro])
            },
          }}
        >
          <div className="flex flex-col gap-4">
            {grupo(
              "Qué aceptas",
              <>
                {sw("cambios", "Acepta cambios")}
                {chips("devoluciones", "Devoluciones de dinero", [
                  { value: "si", label: "Sí" },
                  { value: "falla", label: "Solo por falla" },
                  { value: "no", label: "No" },
                ])}
                {sel("plazoCambio", "Plazo para cambios", PLAZOS, "Días desde la entrega.")}
                {sel("plazoDevolucion", "Plazo para devoluciones", PLAZOS)}
                {sel(
                  "garantia",
                  "Si vino con falla",
                  ["30", "90", "180"].map((d) => ({ value: d, label: `${d} días de garantía` })),
                  "Si la ficha del producto dice su garantía, Sofi usa esa.",
                )}
              </>,
            )}
            {grupo(
              "Las condiciones",
              <>
                {sw("sinUso", "Sin uso")}
                {sw("etiqueta", "Con su etiqueta")}
                {sw("caja", "Con su caja")}
                <form.AppField name="noCambia">
                  {(f) => (
                    <f.Control label="Lo que no se cambia" description="Lo que trae gestorIA para cada rubro.">
                      {() => (
                        <div className="flex flex-col">
                          {(Object.keys(NO_CAMBIA) as NoCambia[]).map((x) => (
                            <Linea key={x} label={NO_CAMBIA[x]}>
                              <Switch
                                checked={f.state.value.includes(x)}
                                onCheckedChange={(on) => {
                                  const nv = on ? [...f.state.value, x] : f.state.value.filter((y) => y !== x)
                                  f.handleChange(nv)
                                }}
                              />
                            </Linea>
                          ))}
                        </div>
                      )}
                    </f.Control>
                  )}
                </form.AppField>
                {sel("oferta", "Lo que está en liquidación u oferta", [
                  { value: "normal", label: "Se cambia y se devuelve igual" },
                  { value: "solo_cambio", label: "Solo cambio" },
                  { value: "no", label: "No se cambia" },
                ])}
              </>,
            )}
            {grupo(
              "El dinero",
              <>
                {chips("dinero", "Cómo vuelve el dinero", (Object.keys(DINERO) as Politica["dinero"][]).map((x) => ({ value: x, label: DINERO[x] })))}
                {vista.dinero === "elige"
                  ? sel("primero", "Sofi ofrece primero", [
                      { value: "saldo", label: "El saldo a favor" },
                      { value: "medio", label: "Devolverlo por el mismo medio" },
                    ])
                  : null}
                {sel("saldoVence", "El saldo a favor vence", [
                  { value: "no", label: "No vence" },
                  { value: "6", label: "A los 6 meses" },
                  { value: "12", label: "Al año" },
                ])}
                {chips("cuando", "Cuándo se devuelve el dinero", (Object.keys(CUANDO) as Politica["cuando"][]).map((x) => ({ value: x, label: CUANDO[x] })), "Recomendado: después de recibir y revisar. Nunca antes, salvo la falla clara con foto si lo eliges.")}
              </>,
            )}
            {grupo(
              "Cómo vuelve el producto",
              <>
                {chips("envio", "Quién paga el envío de vuelta", (Object.keys(ENVIO) as Politica["envio"][]).map((x) => ({ value: x, label: ENVIO[x] })))}
                {vista.envio !== "tienda"
                  ? sel("cambiosGratis", "Cambios sin costo de envío", [
                      { value: "0", label: "Ninguno" },
                      { value: "1", label: "El primero" },
                    ], "Un cambio de talla sin costo ayuda a vender por chat.")
                  : null}
                {sw("recojo", "Lo recoge el repartidor (Lima)")}
                {sw("tienda", "La clienta lo trae a la tienda")}
                {sw("agencia", "Por agencia desde provincia (Shalom u Olva)")}
                {sel("sinStock", "Si no hay stock para el cambio, Sofi ofrece", (Object.keys(SIN_STOCK) as Politica["sinStock"][]).map((x) => ({ value: x, label: SIN_STOCK[x] })))}
              </>,
            )}
          </div>
        </FormPanel>
        <div className="flex min-w-0 flex-col gap-4">
          <AsiLoDice pol={vista} />
          <div className="elevated flex flex-col gap-2 rounded-xl border bg-card p-4 text-sm">
            <b className="flex items-center gap-2">
              <ScrollText className="size-4 text-primary" aria-hidden />
              Cómo la usa Sofi
            </b>
            <p className="text-muted-foreground">
              Sofi informa toda la política, también fuera de horario. El pedido concreto de cambio o
              devolución lo arma según la política y lo pasa a una persona como un tema, con todo el
              chat, sin dejar de contestar lo demás.
            </p>
            <CasillaSofi compacta />
          </div>
        </div>
      </div>
    </PageShell>
  )
}

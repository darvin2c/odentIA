import { Badge, cn } from "@odentia/ui"
import { AgentMark } from "@odentia/ui-patterns"
import { ArrowRight } from "lucide-react"
import type { ReactNode } from "react"
import {
  ACC,
  ACCIONES,
  type AccionId,
  type Clienta,
  type Encargo,
  type Envio,
  encargoDe,
  fecha,
  HIST,
  mensaje,
  META,
  type PlanAccion,
  type RubroC,
  soles,
} from "./datos"
import type { Db } from "./estado"

/**
 * Las campañas: Argos decide a quién y por qué, y se lo encarga a Sofi. Quien le escribe y vende a
 * la clienta, con la voz de la tienda, es siempre Sofi. La clienta no ve a Argos.
 */

export type Resultado = "compro" | "pendiente" | "respondio" | "nada" | "baja" | "planeado"

export interface EnvioC {
  c: Clienta
  a: AccionId
  /** «hoy, 16:00», «Lun 23», «12 oct». */
  cuando: string
  cuandoTipo: "hara" | "semana" | "antes"
  motivo: string
  texto: string
  res: Resultado
  resTexto: string
  /** Lo que hizo Sofi en la conversación. */
  conv: string
  v?: number
  pedido?: string
  chat?: "rocio" | "fio"
  plan?: Envio
}

const resText: Record<string, [Resultado, string, string]> = {
  Compró: ["compro", "Compró", "Respondió y Sofi cerró la venta en el chat."],
  Respondió: ["respondio", "Respondió", "Respondió y conversó con Sofi; no compró."],
  "Sin respuesta": ["nada", "Sin respuesta", "No respondió. Sofi no volvió a escribir."],
}

/** Rocío y Fiorella: lo que pasa en los chats de ejemplo cambia su campaña. */
function vivo(c: Clienta, d: Db, R: RubroC): EnvioC | null {
  const size = c.datos.talla?.valor ?? R.sizes[c.s] ?? ""
  const nv = R.nuevo
  if (c.id === "c5") {
    const step = d.chat.rocio
    const base = {
      c,
      a: "despertar" as AccionId,
      cuando: "Lun 23",
      cuandoTipo: "semana" as const,
      motivo: `no compra hace 140 días y compraba ${R.P[3]?.cat.toLowerCase() ?? ""} ${size} · dormida`,
      texto: mensaje("despertar", c, R),
      chat: "rocio" as const,
    }
    if (d.paid)
      return {
        ...base,
        res: "compro",
        resTexto: "Compró",
        conv: `Pidió fotos y una rebaja; Sofi le dejó ${nv.name.toLowerCase()} en ${soles(nv.price - 10)} pagando ese día y armó el pedido. Una persona confirmó el Yape.`,
        v: nv.price,
        pedido: "0161",
      }
    if (step >= 3)
      return {
        ...base,
        res: "pendiente",
        resTexto: "Pidió · pago por confirmar",
        conv: "Pidió fotos y una rebaja; Sofi le dio la única oferta con plazo y armó el pedido.",
        pedido: "0161",
      }
    if (step >= 1)
      return {
        ...base,
        res: "respondio",
        resTexto: "Respondió",
        conv: "Pidió fotos; Sofi se las mandó.",
      }
    return { ...base, res: "nada", resTexto: "Sin respuesta aún", conv: "Todavía no responde." }
  }
  if (c.id === "c8") {
    const base = {
      c,
      a: "nuevo" as AccionId,
      cuando: "Lun 23",
      cuandoTipo: "semana" as const,
      motivo: `compró ${nv.cat.toLowerCase()} 2 veces y llegó ${nv.name.toLowerCase()} ${R.fit(size)}`,
      texto: mensaje("nuevo", c, R),
      chat: "fio" as const,
    }
    return c.consent.estado === "baja"
      ? {
          ...base,
          res: "baja",
          resTexto: "Pidió que no le escriban",
          conv: "Dijo «ya no me mandes estas cosas»; Sofi le confirmó y Argos anotó la baja.",
        }
      : { ...base, res: "nada", resTexto: "Sin respuesta aún", conv: "Todavía no responde." }
  }
  return null
}

/** Cada envío de cada campaña: lo que hará, lo de esta semana y algunos de antes. */
export function enviosDe(d: Db, R: RubroC, plan: Record<AccionId, PlanAccion>): EnvioC[] {
  const out: EnvioC[] = []
  for (const a of ACCIONES)
    for (const e of plan[a.id].to)
      out.push({
        c: e.c,
        a: a.id,
        cuando: a.when,
        cuandoTipo: "hara",
        motivo: encargoDe(a.id, e.c, R).porque,
        texto: e.text,
        res: "planeado",
        resTexto: d.pausa[a.id]
          ? "En pausa"
          : e.estado === "presupuesto"
            ? "Espera el sí: pasa el presupuesto"
            : e.estado === "permiso"
              ? "Espera tu permiso"
              : `Sofi le escribe ${a.when}`,
        conv: "",
        plan: e,
      })
  for (const c of d.cl) {
    if (c.oculta) continue
    const v = vivo(c, d, R)
    if (v) out.push(v)
    else if (c.semana) {
      const [res, resTexto] = resText[c.semana.res] ?? ["nada", c.semana.res, ""]
      out.push({
        c,
        a: c.semana.a,
        cuando: c.semana.dia,
        cuandoTipo: "semana",
        motivo: c.semana.motivo,
        texto: mensaje(c.semana.a, c, R),
        res,
        resTexto,
        conv: c.semana.conv,
        v: c.semana.v,
        pedido: c.semana.pedido,
      })
    }
    for (const [dd, a, r, val] of c.hist) {
      const [res, resTexto, conv] = resText[r] ?? ["nada", r, ""]
      out.push({
        c,
        a,
        cuando: fecha(dd),
        cuandoTipo: "antes",
        motivo: `entró por la regla: ${ACC[a].who(R).toLowerCase()}`,
        texto: mensaje(a, c, R),
        res,
        resTexto,
        conv,
        v: val,
        pedido: res === "compro" ? `0${130 - Math.round(dd / 3)}` : undefined,
      })
    }
  }
  return out
}

export interface Cifras {
  recibieron: number
  pagados: number
  respondieron: number
  conversaron: number
  compraron: number
  vendido: number
  costo: number
  bajas: number
}

/** Las cifras de una campaña en las últimas 4 semanas, con lo que pasó en los chats de ejemplo. */
export function cifrasDe(a: AccionId, d: Db): Cifras {
  const h = HIST[a]
  const e = d.extra[a] ?? { r: 0, k: 0, c: 0, v: 0, b: 0 }
  return {
    recibieron: h[0],
    pagados: h[1],
    respondieron: h[2] + e.r,
    conversaron: h[3] + e.k,
    compraron: h[4] + e.c,
    vendido: h[5] + e.v,
    costo: h[1] * META,
    bajas: h[6] + e.b,
  }
}

export const retorno = (x: Cifras) =>
  x.costo ? `${Math.round(x.vendido / x.costo).toLocaleString("es-PE")} a 1` : "Sin costo"

export function ResBadge({ e }: { e: EnvioC }) {
  const v =
    e.res === "compro"
      ? "success"
      : e.res === "pendiente" || e.res === "planeado"
        ? "warning"
        : e.res === "baja"
          ? "destructive"
          : e.res === "respondio"
            ? "secondary"
            : "outline"
  return (
    <Badge variant={e.res === "planeado" ? "soft" : v}>
      {e.res === "compro" && e.v ? `Compró ${soles(e.v)}` : e.resTexto}
    </Badge>
  )
}

/** El encargo de Argos a Sofi: para quién, por qué, qué ofrecer, el plazo y lo que no debe hacer. */
export function EncargoCard({
  e,
  estado,
  className,
}: {
  e: Encargo
  estado?: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-xl border border-agent-border bg-agent-soft/50 p-4",
        className,
      )}
    >
      <div className="flex flex-wrap items-center gap-1.5 text-xs font-semibold text-muted-foreground">
        <AgentMark size="sm" />
        Argos
        <ArrowRight className="size-3.5" aria-label="le encarga a" />
        <span className="rounded-full bg-primary-soft px-2 py-0.5 text-primary-soft-foreground">
          Sofi
        </span>
        {estado ? <span className="ml-auto">{estado}</span> : null}
      </div>
      <p className="text-[15px] font-semibold leading-snug">
        Campaña «{e.campana}» para {e.para}
      </p>
      <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[8.5rem_minmax(0,1fr)]">
        <dt className="text-muted-foreground">Por qué salió</dt>
        <dd>{e.porque[0]?.toUpperCase() + e.porque.slice(1)}.</dd>
        <dt className="text-muted-foreground">Qué ofrecer</dt>
        <dd>{e.ofrecer}</dd>
        <dt className="text-muted-foreground">Plazo</dt>
        <dd>{e.plazo}</dd>
        <dt className="text-muted-foreground">Lo que no debe hacer</dt>
        <dd>
          <ul className="flex list-disc flex-col gap-0.5 pl-4">
            {e.noHacer.map((x) => (
              <li key={x}>{x}</li>
            ))}
          </ul>
        </dd>
      </dl>
      <p className="text-xs text-muted-foreground">
        Desde aquí Sofi escribe, conversa y vende como siempre: una sola oferta con plazo, el
        carrito y «Pagar ahora».
      </p>
    </div>
  )
}

/** Una campaña ya escrita: por qué salió, qué hizo Sofi y cómo terminó. */
export function CampanaHecha({ e, R, accion }: { e: EnvioC; R: RubroC; accion?: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5 text-sm">
      <span className="flex flex-wrap items-center gap-2">
        <span className="font-medium">«{ACC[e.a].t(R)}»</span>
        <span className="text-xs text-muted-foreground">{e.cuando}</span>
        <span className="ml-auto">
          <ResBadge e={e} />
        </span>
      </span>
      <span className="text-muted-foreground">Por qué: {e.motivo}.</span>
      {e.conv ? <span>Sofi: {e.conv}</span> : null}
      {e.pedido ? (
        <span className="text-xs text-muted-foreground">
          Pedido {e.pedido} · Venta de la campaña «{ACC[e.a].t(R)}»
        </span>
      ) : null}
      {accion}
    </div>
  )
}

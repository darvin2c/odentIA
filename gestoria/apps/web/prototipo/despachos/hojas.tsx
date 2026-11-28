import { Checkbox, cn, Input, toast } from "@odentia/ui"
import { RadioChips } from "@odentia/ui-patterns"
import { empacar } from "../pedidos/acciones"
import { Hoja } from "../pedidos/hoja"
import { ChevronLeft, ChevronRight, CircleAlert, MessageCircle } from "lucide-react"
import { type ReactNode, useId, useState } from "react"
import { avisar, money, mover, type Pedido, pedidosDe } from "../pedidos/modelo"
import { useRuta } from "../ruta"
import { TiraDias } from "./gestos"
import {
  CUPO,
  corto,
  type Ent,
  entregasDe,
  etiqueta,
  type Faltas,
  FERIADOS,
  FRANJA_NOMBRE,
  FRANJAS,
  foto,
  HOY,
  largo,
  ocupadas,
  REPARTIDORES,
  semanaDe,
  sumar,
} from "./semana"

/* ---------- Lo que se hace con una entrega (la misma operación del pedido) ---------- */

/** Quién la lleva si gestorIA elige: el que sale ese día y tiene sitio en la franja, el más libre. */
export function elegirSolo(
  list: Ent[],
  fecha: string,
  franja: string | null,
  faltas: Faltas,
  sin?: string,
): string | null {
  const libres = REPARTIDORES.filter(
    (r) =>
      r !== sin && !(faltas[fecha] ?? []).includes(r) && ocupadas(list, fecha, franja, r) < CUPO,
  ).sort((a, b) => ocupadas(list, fecha, franja, a) - ocupadas(list, fecha, franja, b))
  return libres[0] ?? null
}

export function textoAviso(p: Pedido, fecha: string, franja: string | null, rep: string | null) {
  const n = p.clienta.split(" ")[0]
  const cuando = fecha === HOY ? "hoy" : `el ${largo(fecha)}`
  return `${n}, tu pedido ${p.id} llega ${cuando}${franja ? ` entre ${franja.replace(" a ", " y ")}` : ""}${rep ? ` con ${rep}` : ""}. Si no te queda bien, respóndeme y lo cambiamos.`
}

export function pasar(
  rubro: Parameters<typeof mover>[0],
  p: Pedido,
  fecha: string,
  franja: string | null,
  rep: string | null,
  sofi: boolean,
  quien = "Rosa",
) {
  const texto = textoAviso(p, fecha, franja, rep)
  // La parada de un recojo: se mueve el día del caso (el pedido ya se entregó).
  const real = pedidosDe(rubro).find((x) => x.id === p.id)
  if (real?.vuelta && real.paso === "entregado") {
    const n = p.clienta.split(" ")[0]
    mover(
      rubro,
      p.id,
      (x) => {
        x.vuelta!.dia = etiqueta(fecha)
        x.vuelta!.franja = franja ?? undefined
        x.vuelta!.repartidor = rep ?? undefined
        if (sofi)
          avisar(
            x,
            "cambio",
            `${n}, pasamos a recoger tu ${x.vuelta!.tipo === "cambio" ? "cambio" : "devolución"} ${fecha === HOY ? "hoy" : `el ${largo(fecha)}`}${franja ? ` entre ${franja.replace(" a ", " y ")}` : ""}${rep ? ` con ${rep}` : ""}.`,
          )
      },
      {
        actor: quien === "gestorIA" ? "gestoria" : "persona",
        quien,
        texto: `Pasó el recojo al ${largo(fecha)}${rep ? `, con ${rep}` : ""}.${sofi ? " Sofi le avisó." : " Sin aviso a la clienta."}`,
      },
    )
    return
  }
  mover(
    rubro,
    p.id,
    (x) => {
      x.entrega.dia = etiqueta(fecha)
      x.entrega.franja = franja
      x.entrega.repartidor = rep
      x.noEntregado = undefined
      if (x.toca?.accion === "pasar" || x.toca?.accion === "asignar") x.toca = undefined
      if (fecha !== HOY && (x.paso === "preparando" || x.paso === "por_salir")) x.paso = "pagado"
      if (fecha === HOY && x.paso === "pagado") x.paso = "preparando"
      if (sofi) avisar(x, "cambio", texto)
    },
    {
      actor: quien === "gestorIA" ? "gestoria" : "persona",
      quien,
      texto: `Lo pasó al ${largo(fecha)}${franja ? `, ${FRANJA_NOMBRE[franja]?.toLowerCase() ?? franja}` : ""}${rep ? `, con ${rep}` : ""}.${sofi ? " Sofi le avisó." : " Sin aviso a la clienta."}`,
    },
  )
}

/** «Listo»: la misma operación de Pedidos (`empacar`), con «Deshacer» en el aviso. */
export function listo(rubro: Parameters<typeof mover>[0], e: Ent) {
  empacar(rubro, e.p)
}

/* ---------- Piezas ---------- */

export function Foto({ e, className }: { e: Ent; className?: string }) {
  const src = e.p.lineas[0]?.foto
  return src ? (
    <img
      src={foto(src)}
      alt=""
      draggable={false}
      className={cn("size-12 shrink-0 rounded-lg bg-muted object-cover", className)}
    />
  ) : (
    <span className={cn("size-12 shrink-0 rounded-lg bg-muted", className)} />
  )
}

/** Con la etapa «Pagado», el cobro «Pagado» sobra: no se repite. */
export const mostrarCobro = (e: Ent) => !(e.etapa === "pagado" && e.cobro.tono === "ok")

export function Cobro({ e, className, corto }: { e: Ent; className?: string; corto?: boolean }) {
  if (!mostrarCobro(e)) return null
  return (
    <span
      className={cn(
        "font-medium tabular-nums",
        e.cobro.tono === "ok"
          ? "text-success"
          : e.cobro.tono === "falta"
            ? "text-warning"
            : "text-destructive",
        className,
      )}
    >
      {corto ? e.cobro.texto.replace(" · al recibir", "").replace("Pago por confirmar", "Por confirmar") : e.cobro.texto}
    </span>
  )
}

/** Lo que dirá Sofi si se marca: siempre a la vista antes de mandarlo. */
export function SofiAvisa({
  on,
  set,
  texto,
}: {
  on: boolean
  set: (v: boolean) => void
  texto: string
}) {
  return (
    <div className="flex flex-col gap-2 rounded-xl border p-3">
      <label className="flex min-h-11 items-start gap-3 text-sm">
        <Checkbox checked={on} onCheckedChange={(v) => set(!!v)} className="mt-0.5 size-5" />
        <span className="flex flex-col gap-0.5">
          <span className="font-medium">Que Sofi le avise por WhatsApp</span>
          <span className="text-xs text-muted-foreground">Si no lo marcas, no le llega nada.</span>
        </span>
      </label>
      {on ? (
        <p className="ml-8 rounded-lg bg-muted px-3 py-2 text-sm">
          <MessageCircle className="mr-1.5 inline size-3.5 text-muted-foreground" aria-hidden />«
          {texto}»
        </p>
      ) : null}
    </div>
  )
}

function Campo({
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

/* ---------- Pasar a… (también lo que abre soltar una entrega) ---------- */

export function PasarHoja({
  e,
  inicial,
  faltas,
  onClose,
}: {
  e: Ent
  inicial?: { fecha?: string; franja?: string | null; rep?: string | null }
  faltas: Faltas
  onClose: () => void
}) {
  const { rubro } = useRuta()
  const todas = entregasDe(pedidosDe(rubro)).filter((x) => x.p.id !== e.p.id)
  const [fecha, setFecha] = useState(inicial?.fecha ?? (e.fecha <= HOY ? sumar(HOY, 1) : e.fecha))
  const [semana, setSemana] = useState(semanaDe(fecha)[0]!)
  const [franja, setFranja] = useState<string | null>(
    inicial?.franja !== undefined ? inicial.franja : (e.p.entrega.franja ?? FRANJAS[0]),
  )
  const agencia = e.p.entrega.tipo === "agencia"
  const [rep, setRep] = useState<string>(
    inicial?.rep ??
      (e.p.entrega.repartidor && inicial?.fecha === undefined ? e.p.entrega.repartidor : "solo"),
  )
  const [sofi, setSofi] = useState(true)
  const solo = agencia ? null : elegirSolo(todas, fecha, franja, faltas)
  const quien = agencia ? null : rep === "solo" ? solo : rep
  const feriado = FERIADOS[fecha]
  const lleno = !agencia && quien && franja ? ocupadas(todas, fecha, franja, quien) >= CUPO : false
  const falta = quien ? (faltas[fecha] ?? []).includes(quien) : false
  const texto = textoAviso(e.p, fecha, franja, quien)
  const dias = semanaDe(semana)
  return (
    <Hoja
      open
      onClose={onClose}
      title="Pasar a…"
      description={`${e.p.clienta} · ${e.p.id} · ${e.p.entrega.zona}`}
      submitLabel={`Pasar al ${corto(fecha)}`}
      onSubmit={(ev) => {
        ev.preventDefault()
        pasar(rubro, e.p, fecha, franja, quien, sofi)
        toast.success(`Pasó al ${largo(fecha)}${franja ? `, ${franja}` : ""}`.replace(/\.?$/, "."), {
          description: sofi ? "Sofi le avisó a la clienta." : "No se le avisó a la clienta.",
        })
        onClose()
      }}
    >
      <Campo label="Día">
        {(id) => (
          <div aria-labelledby={id} role="group" className="flex flex-col gap-1">
            <div className="flex items-center justify-between">
              <button
                type="button"
                aria-label="Semana anterior"
                onClick={() => setSemana(sumar(semana, -7))}
                className="flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
              >
                <ChevronLeft aria-hidden className="size-5" />
              </button>
              <span className="text-sm text-muted-foreground">
                {corto(dias[0]!)} – {corto(dias[6]!)}
              </span>
              <button
                type="button"
                aria-label="Semana siguiente"
                onClick={() => setSemana(sumar(semana, 7))}
                className="flex size-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
              >
                <ChevronRight aria-hidden className="size-5" />
              </button>
            </div>
            <TiraDias
              className="gap-0.5"
              dates={dias}
              value={fecha}
              today={HOY}
              onChange={setFecha}
              load={(d) => ({
                count: todas.filter((x) => x.fecha === d).length,
                feriado: FERIADOS[d],
              })}
            />
          </div>
        )}
      </Campo>
      {feriado ? (
        <p className="flex gap-2 rounded-xl bg-warning-soft px-3 py-2.5 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          El {largo(fecha)} es feriado ({feriado}): la tienda marcó que no reparte. Si la pasas
          igual, sale ese día.
        </p>
      ) : null}
      {agencia ? null : (
        <Campo label="Franja">
          {(id) => (
            <RadioChips
              // En el celular, 44 px por opción (la pieza común da 40): va en el PR de shared.
              className="max-sm:[&_label]:min-h-11 pointer-coarse:[&_label]:min-h-11"
              aria-labelledby={id}
              value={franja}
              options={FRANJAS.map((f) => ({ value: f, label: FRANJA_NOMBRE[f] ?? f }))}
              onChange={setFranja}
            />
          )}
        </Campo>
      )}
      {agencia ? null : (
        <Campo
          label="Quién lo lleva"
          help={
            rep === "solo"
              ? solo
                ? `gestorIA elige según la zona y la franja: hoy sería ${solo}.`
                : "No hay nadie libre en esa franja: queda en «Te toca» para que elijas."
              : "Le llega el aviso a su app, gestorIA Reparto."
          }
        >
          {(id) => (
            <RadioChips
              // En el celular, 44 px por opción (la pieza común da 40): va en el PR de shared.
              className="max-sm:[&_label]:min-h-11 pointer-coarse:[&_label]:min-h-11"
              aria-labelledby={id}
              value={rep}
              options={[
                { value: "solo", label: "Que elija gestorIA" },
                ...REPARTIDORES.map((r) => ({ value: r, label: r })),
              ]}
              onChange={(v) => setRep(v ?? "solo")}
            />
          )}
        </Campo>
      )}
      {lleno || falta ? (
        <p className="flex gap-2 rounded-xl bg-warning-soft px-3 py-2.5 text-sm">
          <CircleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
          {falta
            ? `${quien} no viene ese día.`
            : `${quien} ya lleva ${CUPO} en esa franja, su máximo. Si la pasas igual, lleva ${CUPO + 1}.`}
        </p>
      ) : null}
      <SofiAvisa on={sofi} set={setSofi} texto={texto} />
    </Hoja>
  )
}

/* ---------- La agencia: anotar el número ---------- */

export function NumeroHoja({ e, onClose }: { e: Ent; onClose: () => void }) {
  const { rubro } = useRuta()
  const [num, setNum] = useState("")
  const [sofi, setSofi] = useState(true)
  const n = e.p.clienta.split(" ")[0]
  const ag = e.p.entrega.agencia ?? "la agencia"
  const texto = `${n}, tu pedido ${e.p.id} va por ${ag}, número de envío ${num || "…"}. Lo recoges en su agencia de ${e.p.entrega.zona.split(",")[0]}.`
  const id = useId()
  return (
    <Hoja
      open
      onClose={onClose}
      title={`Lo dejé en ${ag}`}
      description={`${e.p.clienta} · ${e.p.id} · ${e.p.entrega.zona}`}
      submitLabel="Guardar y avisar"
      onSubmit={(ev) => {
        ev.preventDefault()
        if (!num.trim()) return
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
        onClose()
      }}
    >
      <div className="flex flex-col gap-2">
        <label htmlFor={id} className="text-sm font-medium">
          N.º de envío de {ag}
        </label>
        <Input
          id={id}
          inputMode="numeric"
          autoComplete="off"
          value={num}
          onChange={(ev) => setNum(ev.target.value)}
          placeholder="Está en el comprobante: 7 a 10 números"
          className="h-11"
        />
      </div>
      <SofiAvisa on={sofi} set={setSofi} texto={texto} />
    </Hoja>
  )
}

/* ---------- El repartidor que no vino ---------- */

export function FaltaHoja({
  rep,
  faltas,
  setFaltas,
  onClose,
}: {
  rep: string
  faltas: Faltas
  setFaltas: (f: Faltas) => void
  onClose: () => void
}) {
  const { rubro } = useRuta()
  const todas = entregasDe(pedidosDe(rubro))
  const suyas = todas.filter(
    (e) =>
      e.fecha === HOY &&
      e.p.entrega.repartidor === rep &&
      !["en_camino", "entregado"].includes(e.estado),
  )
  const nuevasFaltas = { ...faltas, [HOY]: [...(faltas[HOY] ?? []), rep] }
  // gestorIA reparte: primero a quien tiene sitio hoy; si no hay, al día siguiente en la misma franja.
  const plan: { e: Ent; fecha: string; rep: string | null }[] = []
  const simuladas = todas.filter((e) => !suyas.includes(e))
  for (const e of suyas) {
    const hoy = elegirSolo(simuladas, HOY, e.p.entrega.franja, nuevasFaltas)
    const fecha = hoy ? HOY : sumar(HOY, 1)
    const quien = hoy ?? elegirSolo(simuladas, fecha, e.p.entrega.franja, nuevasFaltas)
    plan.push({ e, fecha, rep: quien })
    simuladas.push({ ...e, fecha, p: { ...e.p, entrega: { ...e.p.entrega, repartidor: quien } } })
  }
  const [sofi, setSofi] = useState(true)
  const otroDia = plan.filter((x) => x.fecha !== HOY)
  const ej = otroDia[0] ?? plan[0]
  return (
    <Hoja
      open
      onClose={onClose}
      title={`${rep} no viene hoy`}
      description={`gestorIA repartió sus ${plan.length} entregas. Revísalo y confírmalo.`}
      submitLabel="Hacerlo así"
      onSubmit={(ev) => {
        ev.preventDefault()
        setFaltas(nuevasFaltas)
        for (const x of plan)
          pasar(rubro, x.e.p, x.fecha, x.e.p.entrega.franja, x.rep, sofi && x.fecha !== HOY, "Rosa")
        toast.success(`Listo: ${plan.length} entregas de ${rep} repartidas.`, {
          description: otroDia.length
            ? `${otroDia.length} pasan a mañana${sofi ? "; Sofi les avisó." : "."}`
            : undefined,
        })
        onClose()
      }}
    >
      {plan.length === 0 ? (
        <p className="text-sm text-muted-foreground">Hoy ya no le queda nada por llevar.</p>
      ) : (
        <ul className="flex flex-col divide-y rounded-xl border">
          {plan.map((x) => (
            <li key={x.e.id} className="flex items-center gap-3 p-3">
              <Foto e={x.e} className="size-10" />
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate font-medium">{x.e.p.clienta}</span>
                <span className="truncate text-xs text-muted-foreground">
                  {x.e.p.entrega.zona} · {x.e.p.entrega.franja}
                </span>
              </span>
              <span className={cn("text-right text-sm", x.fecha !== HOY && "text-warning")}>
                {x.fecha === HOY ? "Hoy" : `Mañana, ${corto(x.fecha)}`}
                <br />
                <span className="text-xs text-muted-foreground">{x.rep ?? "sin repartidor"}</span>
              </span>
            </li>
          ))}
        </ul>
      )}
      {otroDia.length ? (
        <p className="text-sm text-muted-foreground">
          Kevin ya tiene su cupo esta tarde ({CUPO}). Las que no caben pasan a mañana en la misma
          franja. Puedes cambiar cualquiera después con «Pasar a…».
        </p>
      ) : null}
      {ej && otroDia.length ? (
        <SofiAvisa
          on={sofi}
          set={setSofi}
          texto={textoAviso(ej.e.p, ej.fecha, ej.e.p.entrega.franja, ej.rep)}
        />
      ) : null}
    </Hoja>
  )
}

/** Lo que un repartidor entrega a Caja al cerrar el día. */
export function cajaTexto(rep: string, monto: number) {
  return `Recibí ${money(monto)} de ${rep}`
}

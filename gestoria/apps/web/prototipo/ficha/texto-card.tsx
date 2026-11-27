import { Button, cn, Input, Textarea } from "@odentia/ui"
import { Check, Sparkles, Wand2, X } from "lucide-react"
import { useEffect, useId, useRef, useState } from "react"
import type { Producto, Rubro } from "../datos"
import { cambiar } from "../tienda"
import { Propuesto, Seccion } from "./piezas"

const GANCHO: Record<string, string> = {
  Calzado: "ligera y cómoda para todo el día",
  Ropa: "fresca y fácil de combinar",
  Cosmética: "de larga duración y fácil de aplicar",
  Tecnología: "livianos y con buen sonido",
  Hogar: "que le da color a tu sala",
}

function kindOf(p: Producto, R: Rubro) {
  return (
    Object.values(R.kinds).find(
      (k) => k.name === p.name || p.name.startsWith(k.name.split(" ")[0]!),
    ) ?? null
  )
}

/** Lo que propone la IA, armado con lo que ya tiene la ficha (fotos y datos), nunca con precios. */
function propuesta(p: Producto, R: Rubro, modo: "completar" | "mejorar"): string {
  const k = kindOf(p, R)
  const base = (p.texto.trim() || k?.texto || p.name).replace(/\.$/, "")
  const hechos = R.datos
    .filter((d) => d.type === "chips" || d.type === "text")
    .map((d) => [d, p.datos[d.id]] as const)
    .filter(([, v]) => typeof v === "string" && v.trim())
    .slice(0, 3)
    .map(([d, v]) => {
      const t = String(v).toLowerCase()
      if (d.id === "horma") return `Calza ${t}`
      if (d.id === "ancho")
        return t === "una talla más" ? "Si tienes el pie ancho, pide una talla más" : ""
      if (d.id === "material" || d.id === "tela") return `De ${t}`
      return `${d.label}: ${t}`
    })
    .filter(Boolean)
  if (modo === "completar") return `${base}. ${hechos.join(". ")}.`
  const colores = p.colors.length > 1 ? ` En ${p.colors.map((c) => c.name).join(" y ")}.` : ""
  return `${k?.texto.replace(/\.$/, "") ?? base}, ${GANCHO[R.label] ?? "hecha para durar"}.${colores} ${hechos.join(". ")}.`
}

/** El texto aparece como si se escribiera; sin movimiento, de una vez. */
function useTypewriter(text: string | null) {
  const [shown, setShown] = useState("")
  useEffect(() => {
    if (!text) return setShown("")
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return setShown(text)
    let i = 0
    const t = setInterval(() => {
      i += 3
      setShown(text.slice(0, i))
      if (i >= text.length) clearInterval(t)
    }, 16)
    return () => clearInterval(t)
  }, [text])
  return shown
}

export function TextCard({ p, edit, R }: { p: Producto; edit: boolean; R: Rubro }) {
  const nameId = useId()
  const textId = useId()
  const [pensando, setPensando] = useState<null | "completar" | "mejorar">(null)
  const [prop, setProp] = useState<string | null>(null)
  const shown = useTypewriter(prop)
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  const pedir = (modo: "completar" | "mejorar") => {
    setProp(null)
    setPensando(modo)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => {
      setPensando(null)
      setProp(propuesta(p, R, modo))
    }, 850)
  }
  return (
    <Seccion
      id="texto"
      title="Nombre y descripción para vender"
      summary={p.name}
      contains={["campo-nombre"]}
    >
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2">
          <label htmlFor={nameId} className="text-sm font-medium">
            Nombre
          </label>
          {p.ai.name && edit ? (
            <Propuesto
              porque={`Visto en las fotos: «${p.ai.name}».`}
              onAccept={() =>
                cambiar(
                  p.id,
                  "Aceptaste el nombre",
                  (x) => {
                    x.name = x.ai.name!
                    x.ai.name = undefined
                  },
                  { toast: true },
                )
              }
              onDiscard={() =>
                cambiar(
                  p.id,
                  "Descartaste el nombre propuesto",
                  (x) => {
                    if (x.name === x.ai.name) x.name = ""
                    x.ai.name = undefined
                  },
                  { toast: true },
                )
              }
            />
          ) : null}
        </div>
        <Input
          id={nameId}
          value={p.name}
          disabled={!edit}
          className={cn(p.ai.name && p.ai.name === p.name && "propuesta")}
          onChange={(e) =>
            cambiar(
              p.id,
              "Cambiaste el nombre",
              (x) => {
                x.name = e.target.value
                x.ai.name = undefined
              },
              { group: "nombre" },
            )
          }
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor={textId} className="text-sm font-medium">
            Descripción para vender
          </label>
          {edit ? (
            <span className="flex gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="text-primary"
                disabled={!!pensando}
                onClick={() => pedir("completar")}
              >
                <Sparkles aria-hidden />
                Completar
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-primary"
                disabled={!!pensando || !p.texto.trim()}
                onClick={() => pedir("mejorar")}
              >
                <Wand2 aria-hidden />
                Mejorar
              </Button>
            </span>
          ) : null}
        </div>
        <Textarea
          id={textId}
          value={p.texto}
          disabled={!edit}
          rows={3}
          placeholder="Qué es, de qué está hecho y para qué sirve. Sofi lo usa al responder."
          onChange={(e) =>
            cambiar(p.id, "Cambiaste la descripción", (x) => (x.texto = e.target.value), {
              group: "texto",
            })
          }
        />
        {pensando ? (
          <div className="propuesta entra flex flex-col gap-2 rounded-2xl border p-3" role="status">
            <span className="flex items-center gap-1.5 text-xs font-medium text-primary">
              <Sparkles className="pulso size-3.5" aria-hidden />
              {pensando === "completar"
                ? "Completando con las fotos y los datos…"
                : "Mejorando el texto…"}
            </span>
            <span className="brillo h-3 w-11/12 rounded-full" />
            <span className="brillo h-3 w-8/12 rounded-full" />
          </div>
        ) : prop ? (
          <div className="propuesta entra flex flex-col gap-2 rounded-2xl border p-3">
            <span className="flex items-center gap-1.5 text-xs font-medium text-primary">
              <Sparkles className="size-3.5" aria-hidden />
              Propuesta de la IA · no se guarda hasta que la uses
            </span>
            <p className="text-sm leading-relaxed" aria-live="polite">
              {shown}
              {shown.length < prop.length ? (
                <span className="pulso ml-0.5 inline-block h-4 w-0.5 translate-y-0.5 bg-primary" />
              ) : null}
            </p>
            <div className="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setProp(null)}>
                <X aria-hidden />
                Descartar
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  const t = prop
                  setProp(null)
                  cambiar(p.id, "Usaste el texto propuesto", (x) => (x.texto = t), { toast: true })
                }}
              >
                <Check aria-hidden />
                Usar este texto
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Seccion>
  )
}

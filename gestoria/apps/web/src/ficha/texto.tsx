import { Input, Textarea } from "@odentia/ui"
import { useEffect, useId, useState } from "react"
import { useFichaContext } from "./contexto"
import { FieldProblem, Section } from "./piezas"

/**
 * El nombre y la descripción para vender (prototipo `ficha/texto-card.tsx`): lo que Sofi puede
 * contar del producto. «Completar» y «Mejorar» con la IA llegan con su propio cambio
 * (`AiSuggestion`): aquí todavía no se dibujan.
 */
export function TextCard() {
  const { draft, edit, change, errors } = useFichaContext()
  const nameId = useId()
  const textId = useId()
  // El nombre vacío no se guarda: queda lo escrito y se avisa en el campo.
  const [name, setName] = useState(draft.name)
  useEffect(() => setName(draft.name), [draft.name])
  const empty = !name.trim()
  return (
    <Section id="texto" title="Nombre y descripción para vender" summary={draft.name}>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={nameId} className="text-sm font-medium">
          Nombre
        </label>
        <Input
          id={nameId}
          value={name}
          maxLength={120}
          disabled={!edit}
          aria-invalid={empty || errors.name ? true : undefined}
          onChange={(e) => {
            setName(e.target.value)
            if (e.target.value.trim())
              change("Cambiaste el nombre", (d) => (d.name = e.target.value), { group: "nombre" })
          }}
        />
        <FieldProblem message={empty ? "Escribe el nombre del producto" : errors.name} />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={textId} className="text-sm font-medium">
          Descripción para vender
        </label>
        <Textarea
          id={textId}
          value={draft.description}
          disabled={!edit}
          rows={3}
          maxLength={2000}
          placeholder="Qué es, de qué está hecho y para qué sirve. Sofi lo usa al responder."
          onChange={(e) =>
            change("Cambiaste la descripción", (d) => (d.description = e.target.value), {
              group: "texto",
            })
          }
        />
        <FieldProblem message={errors.description} />
      </div>
    </Section>
  )
}

import { Button, Input, Textarea, toast } from "@odentia/ui"
import { AiSuggestion } from "@odentia/ui-patterns"
import { useMutation } from "@tanstack/react-query"
import { WandSparkles } from "lucide-react"
import { useEffect, useId, useState } from "react"
import { improveText } from "../lib/ia"
import { useFichaContext } from "./contexto"
import { AskButton, CapNote, TextProposal, useFichaIa } from "./ia"
import { FieldProblem, Section } from "./piezas"

/**
 * El nombre y la descripción para vender (prototipo `ficha/texto-card.tsx`): lo que Sofi puede
 * contar del producto. «Completar» pide a la IA que mire las fotos y proponga (✦); «Mejorar» solo
 * reescribe lo que ya escribió la persona, sin sumar datos: si sumara uno, no se propone.
 */
export function TextCard() {
  const { draft, edit, change, errors, store } = useFichaContext()
  const ia = useFichaIa()
  const nameId = useId()
  const textId = useId()
  // El nombre vacío no se guarda: queda lo escrito y se avisa en el campo.
  const [name, setName] = useState(draft.name)
  useEffect(() => setName(draft.name), [draft.name])
  const empty = !name.trim()
  const [better, setBetter] = useState<string | null>(null)
  const improve = useMutation({
    mutationFn: () => improveText(store.id, draft.description),
    onSuccess: (result) => {
      if (result.text && result.text !== draft.description) setBetter(result.text)
      else
        toast(
          result.why
            ? `La IA quería sumar algo que no escribiste (${result.why.toLowerCase()}): queda como estaba.`
            : "Tu texto ya se lee bien: queda como estaba.",
        )
    },
    onError: (error) => toast.error(error.message),
  })
  const canImprove = draft.description.trim().length >= 3
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
        <TextProposal field="nombre" />
      </div>
      <div className="flex flex-col gap-1.5">
        <div className="flex min-h-8 flex-wrap items-center gap-x-1 gap-y-1">
          <label htmlFor={textId} className="mr-auto text-sm font-medium">
            Descripción para vender
          </label>
          {ia.active ? (
            <>
              <AskButton label="Completar" />
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-primary"
                disabled={!canImprove || improve.isPending || (ia.cap ? !ia.cap.available : false)}
                title={
                  canImprove
                    ? "Reescribe lo que escribiste, sin sumar datos"
                    : "Escribe algo primero: la IA solo mejora lo tuyo"
                }
                onClick={() => improve.mutate()}
              >
                <WandSparkles aria-hidden />
                {improve.isPending ? "Mejorando…" : "Mejorar"}
              </Button>
            </>
          ) : null}
        </div>
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
        <CapNote />
        {better ? (
          <AiSuggestion
            text={better}
            title="Mejor escrito · no se guarda hasta que lo uses"
            reason="Solo reescribe lo que escribiste: no suma datos."
            onAccept={(text) => {
              change("Usaste el texto mejorado", (d) => (d.description = text ?? better))
              setBetter(null)
            }}
            onDiscard={() => setBetter(null)}
          />
        ) : (
          <TextProposal field="descripcion" block />
        )}
      </div>
    </Section>
  )
}

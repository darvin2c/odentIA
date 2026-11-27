import {
  Button,
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  toast,
} from "@odentia/ui"
import { Textarea } from "@odentia/ui/components/textarea"
import { PageNotice, SubmitButton } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useLocation } from "@tanstack/react-router"
import { useId, useState } from "react"
import { api, type MyStore, ROLES } from "./lib/api"
import { HELP_KEY, type HelpView, screenOf } from "./lib/ayuda"
import { FormAlert, FormSheet, fieldErrors } from "./piezas"

/**
 * «Pedir ayuda» (entrega 7, tablero 19): lo que pasó, en una frase, y lo que se agrega solo (la
 * pantalla desde la que se pide y el rol en la tienda). Llega a la Bandeja de la administración y
 * la respuesta vuelve a la Ayuda, en «Tus preguntas». Lo tiene todo el equipo (`ayuda.pedir`).
 */
export function AskForHelpSheet({
  store,
  open,
  onClose,
}: {
  store: MyStore
  open: boolean
  onClose: () => void
}) {
  const queryClient = useQueryClient()
  const location = useLocation()
  const [question, setQuestion] = useState("")
  const [empty, setEmpty] = useState(false)
  const id = useId()
  // Si gestorIA no está conectada a la administración, se dice antes de escribir.
  const help = useQuery({
    queryKey: HELP_KEY(store.id),
    queryFn: () => api<HelpView>(`/api/tiendas/${store.id}/ayuda`),
    enabled: open,
  })
  const screen = screenOf(location.href, store.id)
  const ask = useMutation({
    mutationFn: () =>
      api(`/api/tiendas/${store.id}/ayuda`, {
        method: "POST",
        body: { question, screen: screen.path },
      }),
    onSuccess: async () => {
      setQuestion("")
      await queryClient.invalidateQueries({ queryKey: HELP_KEY(store.id) })
      toast.success("Enviado. Te respondemos en Ayuda, en «Tus preguntas».")
      onClose()
    },
  })
  const closed = help.data ? !help.data.connected : false
  const error = empty ? "Cuéntanos qué pasó" : fieldErrors(ask.error).question
  const role = ROLES[store.role].name
  // Lo escrito se queda para la próxima vez (por eso cerrar no pregunta); el error de este
  // intento, no.
  const close = () => {
    ask.reset()
    setEmpty(false)
    onClose()
  }
  return (
    <FormSheet
      open={open}
      title="Pedir ayuda"
      description="Escríbele al equipo de gestorIA."
      onClose={close}
      onSubmit={() => {
        if (closed || ask.isPending) return
        setEmpty(!question.trim())
        if (question.trim()) ask.mutate()
      }}
      footer={
        <>
          <Button variant="outline" type="button" onClick={close}>
            Cancelar
          </Button>
          <SubmitButton type="submit" pending={ask.isPending} disabled={closed}>
            Enviar
          </SubmitButton>
        </>
      }
    >
      <FieldGroup>
        {closed ? (
          <PageNotice tone="aviso" label="Sin conexión">
            Todavía no podemos recibir preguntas desde aquí.
          </PageNotice>
        ) : null}
        <Field data-invalid={error ? true : undefined}>
          <FieldLabel htmlFor={id}>¿Qué pasó?</FieldLabel>
          <Textarea
            id={id}
            value={question}
            maxLength={500}
            rows={5}
            autoFocus
            onChange={(event) => {
              setQuestion(event.target.value)
              if (event.target.value.trim()) setEmpty(false)
            }}
            onKeyDown={(event) => {
              // Enter envía, como en un chat; Mayús + Enter baja de línea.
              if (event.key === "Enter" && !event.shiftKey) {
                event.preventDefault()
                event.currentTarget.form?.requestSubmit()
              }
            }}
            placeholder="Por ejemplo: el pedido 0149 dice que falta cobrar, pero ya me pagó todo."
            aria-invalid={error ? true : undefined}
            aria-describedby={error ? `${id}-error ${id}-extra` : `${id}-extra`}
          />
          {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
          <FieldDescription id={`${id}-extra`}>
            Se agrega solo: esta pantalla y tu rol ({screen.name} · {role} · {store.name}). Te
            respondemos en Ayuda, en «Tus preguntas».
          </FieldDescription>
        </Field>
        <FormAlert error={ask.error} />
      </FieldGroup>
    </FormSheet>
  )
}

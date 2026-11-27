import { FieldGroup, toast } from "@odentia/ui"
import {
  clearSubmitErrors,
  FormDrawer,
  PageNotice,
  useAppForm,
  useFormSurface,
} from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useLocation } from "@tanstack/react-router"
import { z } from "zod"
import { api, type MyStore, ROLES } from "./lib/api"
import { HELP_KEY, type HelpView, screenOf } from "./lib/ayuda"

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
  // Si gestorIA no está conectada a la administración, se dice antes de escribir.
  const help = useQuery({
    queryKey: HELP_KEY(store.id),
    queryFn: () => api<HelpView>(`/api/tiendas/${store.id}/ayuda`),
    enabled: open,
  })
  const screen = screenOf(location.href, store.id)
  const closed = help.data ? !help.data.connected : false
  const ask = useMutation({
    mutationFn: (question: string) =>
      api(`/api/tiendas/${store.id}/ayuda`, {
        method: "POST",
        body: { question, screen: screen.path },
      }),
  })
  const form = useAppForm({
    defaultValues: { question: "" },
    validators: {
      onSubmit: z.object({ question: z.string().trim().min(1, "Cuéntanos qué pasó") }),
    },
    onSubmit: async ({ value, formApi }) => {
      if (closed) return
      await ask.mutateAsync(value.question)
      formApi.reset()
      await queryClient.invalidateQueries({ queryKey: HELP_KEY(store.id) })
      toast.success("Enviado. Te respondemos en Ayuda, en «Tus preguntas».")
      onClose()
    },
  })
  const surface = useFormSurface(form)
  const role = ROLES[store.role].name
  // Lo escrito se queda para la próxima vez (por eso cerrar no pregunta); el error de este
  // intento, no.
  const close = () => {
    clearSubmitErrors(form)
    onClose()
  }
  return (
    <FormDrawer
      {...surface}
      isDirty={false}
      open={open}
      title="Pedir ayuda"
      description="Escríbele al equipo de gestorIA."
      onClose={close}
      submitLabel="Enviar"
      submitDisabled={closed}
    >
      <FieldGroup>
        {closed ? (
          <PageNotice tone="aviso" label="Sin conexión">
            Todavía no podemos recibir preguntas desde aquí.
          </PageNotice>
        ) : null}
        <form.AppField name="question">
          {(field) => (
            <field.TextareaField
              label="¿Qué pasó?"
              maxLength={500}
              rows={5}
              autoFocus
              onKeyDown={(event) => {
                // Enter envía, como en un chat; Mayús + Enter baja de línea.
                if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                  event.preventDefault()
                  event.currentTarget.form?.requestSubmit()
                }
              }}
              placeholder="Por ejemplo: el pedido 0149 dice que falta cobrar, pero ya me pagó todo."
              description={`Se agrega solo: esta pantalla y tu rol (${screen.name} · ${role} · ${store.name}). Te respondemos en Ayuda, en «Tus preguntas».`}
            />
          )}
        </form.AppField>
      </FieldGroup>
    </FormDrawer>
  )
}

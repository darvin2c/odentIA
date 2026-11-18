/**
 * «Kairós responde solo en los chats» (`GET/PUT /api/admin/kairos/sells`): el
 * interruptor general de Kairós cuando vende por WhatsApp, Instagram y
 * Messenger a quien todavía no tiene su app. Solo Administración lo ve y lo
 * cambia (el servidor también lo exige); guarda al momento. Apagado, Kairós
 * vuelve a solo preparar y esas conversaciones esperan a una persona en Hoy.
 */
import { FieldDescription, FieldLabel, toast } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { AgentMark, AgentSurface, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { z } from "zod"
import { api } from "../../lib/api"
import { supportDayTime } from "../../lib/support-words"

export const kairosSellsSchema = z.object({
  enabled: z.boolean(),
  updatedAt: z.string().nullable(),
  updatedBy: z.object({ userId: z.string(), name: z.string() }).nullable(),
})
export type KairosSells = z.infer<typeof kairosSellsSchema>
export const kairosSellsKey = ["admin", "kairos", "sells"] as const

/** «Prendido por Ada el jue 12 nov, 10:05» / «Apagado»: quién lo dejó así y cuándo. */
export function kairosSellsStateWords(sells: KairosSells): string {
  const state = sells.enabled ? "Prendido" : "Apagado"
  if (!sells.updatedAt || !sells.updatedBy) return state
  const first = sells.updatedBy.name.trim().split(/\s+/)[0] || sells.updatedBy.name
  return `${state} por ${first} el ${supportDayTime(sells.updatedAt)}`
}

export function KairosSellsSwitch() {
  const queryClient = useQueryClient()
  const sells = useQuery({
    queryKey: kairosSellsKey,
    queryFn: async () => kairosSellsSchema.parse(await api<unknown>("/api/admin/kairos/sells")),
  })
  const change = useMutation({
    mutationFn: async (enabled: boolean) =>
      kairosSellsSchema.parse(
        await api<unknown>("/api/admin/kairos/sells", {
          method: "PUT",
          body: JSON.stringify({ enabled }),
        }),
      ),
    onSuccess: (next) => {
      queryClient.setQueryData(kairosSellsKey, next)
      void queryClient.invalidateQueries({ queryKey: ["admin", "kairos"] })
      void queryClient.invalidateQueries({ queryKey: ["admin", "chat"] })
      toast.success(
        next.enabled
          ? "Kairós responde solo en los chats de quien todavía no tiene su app"
          : "Kairós ya no responde solo: esas conversaciones esperan a una persona en Hoy",
      )
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const enabled = change.isPending ? (change.variables ?? false) : (sells.data?.enabled ?? false)
  return (
    <AgentSurface aria-labelledby="kairos-vende" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <AgentMark size="sm" />
        <FieldLabel
          htmlFor="kairos-vende-switch"
          id="kairos-vende"
          className="min-w-0 flex-1 text-base"
        >
          Kairós responde solo en los chats
        </FieldLabel>
        <Switch
          id="kairos-vende-switch"
          className="ml-auto"
          checked={enabled}
          disabled={!sells.data || change.isPending}
          aria-describedby="kairos-vende-explica"
          onCheckedChange={(on) => change.mutate(on)}
        />
      </div>
      <FieldDescription id="kairos-vende-explica">
        Por WhatsApp, Instagram y Messenger, a quien todavía no tiene su app. Responde lo de las
        webs y los precios, y agenda presentaciones. Nunca ofrece descuentos. Se prende después de
        medirlo.
      </FieldDescription>
      <p className="text-xs text-muted-foreground">
        {sells.isError
          ? `No pude leer cómo está: ${submitErrorMessage(sells.error)}`
          : sells.data
            ? `${kairosSellsStateWords(sells.data)}. En cada conversación, «Lo atiendo yo» lo pausa solo ahí.`
            : "Leyendo cómo está…"}
      </p>
    </AgentSurface>
  )
}

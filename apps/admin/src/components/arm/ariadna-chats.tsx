/**
 * «Ariadna responde en los chats de las clínicas con app» (`GET/PUT
 * /api/admin/kairos/ariadna`, ADR 0191): el interruptor de Ariadna cuando una
 * clínica que ya tiene su app escribe por WhatsApp, Instagram o Messenger. Va
 * junto al de Kairós, solo para Administración (el servidor también lo exige),
 * y guarda al momento. Apagado, esas conversaciones esperan a Soporte en Hoy.
 */
import { FieldDescription, FieldLabel, toast } from "@odentia/ui"
import { Switch } from "@odentia/ui/components/switch"
import { AgentMark, AgentSurface, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { api } from "../../lib/api"
import { supportDayTime } from "../../lib/support-words"
import { type KairosSells, kairosSellsSchema } from "./kairos-sells"

export const ariadnaChatsKey = ["admin", "kairos", "ariadna"] as const

/** «Prendida por Ada el jue 12 nov, 10:05» / «Apagada»: quién la dejó así y cuándo. */
export function ariadnaChatsStateWords(setting: KairosSells): string {
  const state = setting.enabled ? "Prendida" : "Apagada"
  if (!setting.updatedAt || !setting.updatedBy) return state
  const first = setting.updatedBy.name.trim().split(/\s+/)[0] || setting.updatedBy.name
  return `${state} por ${first} el ${supportDayTime(setting.updatedAt)}`
}

export function AriadnaChatsSwitch() {
  const queryClient = useQueryClient()
  const setting = useQuery({
    queryKey: ariadnaChatsKey,
    queryFn: async () => kairosSellsSchema.parse(await api<unknown>("/api/admin/kairos/ariadna")),
  })
  const change = useMutation({
    mutationFn: async (enabled: boolean) =>
      kairosSellsSchema.parse(
        await api<unknown>("/api/admin/kairos/ariadna", {
          method: "PUT",
          body: JSON.stringify({ enabled }),
        }),
      ),
    onSuccess: (next) => {
      queryClient.setQueryData(ariadnaChatsKey, next)
      void queryClient.invalidateQueries({ queryKey: ["admin", "kairos"] })
      void queryClient.invalidateQueries({ queryKey: ["admin", "chat"] })
      toast.success(
        next.enabled
          ? "Ariadna responde en los chats de las clínicas que ya tienen su app"
          : "Ariadna ya no responde en los chats: esas conversaciones esperan a Soporte en Hoy",
      )
    },
    onError: (error) => toast.error(submitErrorMessage(error)),
  })
  const enabled = change.isPending ? (change.variables ?? false) : (setting.data?.enabled ?? false)
  return (
    <AgentSurface aria-labelledby="ariadna-chats" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-3">
        <AgentMark size="sm" />
        <FieldLabel
          htmlFor="ariadna-chats-switch"
          id="ariadna-chats"
          className="min-w-0 flex-1 text-base"
        >
          Ariadna responde en los chats de las clínicas con app
        </FieldLabel>
        <Switch
          id="ariadna-chats-switch"
          className="ml-auto"
          checked={enabled}
          disabled={!setting.data || change.isPending}
          aria-describedby="ariadna-chats-explica"
          onCheckedChange={(on) => change.mutate(on)}
        />
      </div>
      <FieldDescription id="ariadna-chats-explica">
        Responde cómo se usa el sistema con la misma guía de la Ayuda de la app y el enlace a la
        pantalla. No ve los datos de la clínica. Lo de su cuenta lo pasa a Soporte; cobros, su plan
        u otra sede, a Administración. Se prende después de medirla.
      </FieldDescription>
      <p className="text-xs text-muted-foreground">
        {setting.isError
          ? `No pude leer cómo está: ${submitErrorMessage(setting.error)}`
          : setting.data
            ? `${ariadnaChatsStateWords(setting.data)}. En cada conversación, «Lo atiendo yo» la pausa solo ahí.`
            : "Leyendo cómo está…"}
      </p>
    </AgentSurface>
  )
}

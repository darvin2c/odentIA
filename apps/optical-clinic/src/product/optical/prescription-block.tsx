import { apiFetch } from "@odentia/clinic-app/lib/api"
import type { EncounterBlockContext, ProductEncounterBlocks } from "@odentia/clinic-app/product/product-ui"
import { EYES, lensesFromExam, lensText, readEyeExam, refractionText, VERTEX_FROM_DIOPTERS } from "@odentia/optical"
import { Button, toast } from "@odentia/ui"
import { FormDrawer, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { type FormEvent, useState } from "react"
import { EMPTY_LENSES, LensFields, type LensDrafts, lensDraftsOf, lensesBody } from "./lens-fields"

interface IssuedPrescription {
  id: string
  kind: "anteojos" | "contacto"
  encounterId: string | null
  voidedAt: string | null
  lenses: Record<"od" | "oi", Record<string, unknown> | undefined>
}

/** El mensaje de un rechazo: los de cada dato, todos, o el general. */
function rejectionText(cause: unknown): string {
  const fields = (cause as { fields?: Record<string, string> }).fields
  const messages = fields ? [...new Set(Object.values(fields))] : []
  return messages.length ? messages.join(" ") : submitErrorMessage(cause)
}

/**
 * «Receta de lentes» en la atención (entrega 3 del plan): con la refracción del
 * examen guardada, la de anteojos se emite con un toque; la de lentes de contacto
 * se abre con la graduación compensada por la distancia al ojo y sin prisma, que
 * el optómetra revisa, y su curva base, su diámetro y su marca. La firma quien
 * lleva la atención.
 */
export function usePrescriptionBlocks(ctx: EncounterBlockContext): ProductEncounterBlocks {
  const queryClient = useQueryClient()
  const exam = readEyeExam(ctx.detail.encounter.examination)
  const fromExam = lensesFromExam(exam?.refraccion)
  const [contactOpen, setContactOpen] = useState(false)
  const [contact, setContact] = useState<LensDrafts>(EMPTY_LENSES)
  const [errors, setErrors] = useState<Record<string, string>>({})
  const key = ["lens-prescriptions", ctx.patientId] as const
  const list = useQuery({
    queryKey: key,
    queryFn: () =>
      apiFetch<{ data: { items: IssuedPrescription[] } }>(`/api/patients/${ctx.patientId}/lens-prescriptions`).then((body) => body.data),
    enabled: ctx.canRead,
  })
  const issued = (list.data?.items ?? []).filter((item) => item.encounterId === ctx.encounterId && !item.voidedAt)
  const issue = useMutation({
    mutationFn: async (kind: "anteojos" | "contacto") => {
      // La de anteojos la arma el servidor con el examen guardado: primero se guarda lo escrito.
      await ctx.flush()
      ctx.onPendingChange(true)
      const lenses = kind === "contacto" ? lensesBody("contacto", contact) : undefined
      return apiFetch(`/api/patients/${ctx.patientId}/lens-prescriptions`, {
        method: "POST",
        body: JSON.stringify({ encounterId: ctx.encounterId, kind, ...(lenses ? { lenses } : {}) }),
      })
    },
    onSuccess: async (_result, kind) => {
      await queryClient.invalidateQueries({ queryKey: key })
      await ctx.onChanged()
      toast.success(kind === "anteojos" ? "Receta de anteojos emitida" : "Receta de lentes de contacto emitida")
      setContactOpen(false)
      setContact(EMPTY_LENSES)
    },
    onError: (cause: unknown, kind) => {
      const fields = (cause as { fields?: Record<string, string> }).fields
      // En el cajón, cada error junto a su dato; la de anteojos no tiene cajón: se dice entero.
      if (kind === "contacto" && fields) setErrors(fields)
      else toast.error(rejectionText(cause))
    },
    onSettled: () => ctx.onPendingChange(false),
  })
  const openContact = async () => {
    // La graduación sale del examen ya guardado: lo último escrito también cuenta.
    await ctx.flush()
    const fresh = await apiFetch<{ data: { encounter: { examination: unknown } } }>(
      `/api/patients/${ctx.patientId}/encounters/${ctx.encounterId}`,
    ).catch(() => null)
    const latest = readEyeExam(fresh?.data.encounter.examination ?? ctx.detail.encounter.examination)
    setContact(lensDraftsOf(lensesFromExam(latest?.refraccion, "contacto")))
    setErrors({})
    setContactOpen(true)
  }
  const has = (kind: "anteojos" | "contacto") => issued.some((item) => item.kind === kind)
  const disabled = !ctx.canWrite || !ctx.writable || ctx.locked || issue.isPending
  const content = (
    <div className="flex flex-col gap-3">
      {fromExam ? (
        <dl className="grid grid-cols-[2.5rem_1fr] gap-x-2 gap-y-1 text-sm">
          {EYES.filter((eye) => fromExam[eye.key]).map((eye) => (
            <div key={eye.key} className="contents">
              <dt className="font-semibold">{eye.short}</dt>
              <dd className="tabular-nums">{refractionText(fromExam[eye.key])}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="text-sm text-muted-foreground">Anota la refracción en el examen de la vista y guárdala: de ahí sale la receta.</p>
      )}
      {issued.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm">
          {issued.map((item) => (
            <li key={item.id}>
              Emitida: {item.kind === "anteojos" ? "anteojos" : "lentes de contacto"} ·{" "}
              {EYES.filter((eye) => item.lenses[eye.key]).map((eye) => `${eye.short} ${lensText(item.lenses[eye.key] as never)}`).join(" · ")}
            </li>
          ))}
        </ul>
      ) : null}
      {ctx.canWrite ? (
        <div className="flex flex-wrap gap-2">
          <Button type="button" disabled={disabled || !fromExam || has("anteojos")} onClick={() => issue.mutate("anteojos")}>
            {has("anteojos") ? "Receta de anteojos emitida" : "Emitir receta de anteojos"}
          </Button>
          <Button type="button" variant="outline" disabled={disabled || !fromExam || has("contacto")} onClick={() => void openContact()}>
            {has("contacto") ? "Receta de lentes de contacto emitida" : "Emitir receta de lentes de contacto"}
          </Button>
        </div>
      ) : null}
    </div>
  )
  const overlay = (
    <FormDrawer
      open={contactOpen}
      onClose={() => setContactOpen(false)}
      title="Receta de lentes de contacto"
      description={`La graduación viene de la refracción, llevada al ojo desde ±${VERTEX_FROM_DIOPTERS.toFixed(2).replace(".", ",")} y sin prisma: revísala con la prueba del lente. Agrega la curva base, el diámetro y la marca.`}
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        setErrors({})
        issue.mutate("contacto")
      }}
      isSubmitting={issue.isPending}
      isDirty
      submitLabel="Emitir"
    >
      <LensFields
        idPrefix="contacto"
        kind="contacto"
        value={contact}
        onChange={setContact}
        errors={errors}
        eyes={EYES.filter((eye) => fromExam?.[eye.key])}
      />
    </FormDrawer>
  )
  return {
    blocks: [
      {
        key: "receta-lentes",
        title: "Receta de lentes",
        description: "Sale de la refracción del examen de la vista.",
        summary: issued.length ? `${issued.length === 1 ? "1 receta emitida" : `${issued.length} recetas emitidas`}` : "",
        empty: false,
        content,
      },
    ],
    overlay,
  }
}

import { Button, cn } from "@odentia/ui"
import { DetailDrawer, LoadingState } from "@odentia/ui-patterns"
import { useQuery, useQueryClient } from "@tanstack/react-query"
import { lazy, Suspense, useState } from "react"
import { fetchFormResponses } from "../../lib/clinical-forms"
import { usePermission } from "../../lib/crm"
import { activeOrgLocale, activeOrgTimeZone } from "../../lib/locale"
import type { FormRecord } from "../../lib/patients"

// El formulario abierto es el de Documentos, con sus adendas: se carga al pedirlo.
const ResponseDetail = lazy(() => import("./formularios-tab").then((m) => ({ default: m.ResponseDetail })))

function whenWords(iso: string): string {
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return iso
  return at.toLocaleString(activeOrgLocale(), { timeZone: activeOrgTimeZone(), dateStyle: "medium", timeStyle: "short" })
}

/**
 * Un formulario finalizado, para leerlo dentro de su atención: cada pregunta que
 * se hizo con su respuesta, quién y cuándo, y sus adendas. Las palabras las dice
 * el servidor, las mismas de la copia de la historia.
 */
export function FormRecordView({
  form,
  addendaUntil,
}: {
  form: FormRecord
  /**
   * En la atención firmada: solo las adendas de hasta la firma. Lo agregado después va
   * después de «Firmó…», para que no se lea como parte de lo firmado (QA de la entrega 2).
   */
  addendaUntil?: string | null
}) {
  const shownAddenda = addendaUntil ? form.addenda.filter((addendum) => addendum.createdAt <= addendaUntil) : form.addenda
  return (
    <article aria-label={form.title} className="flex min-w-0 flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-col gap-0.5">
        <h5 className="text-sm font-medium">
          {form.title}
          <span className="font-normal text-muted-foreground"> · versión {form.version}</span>
        </h5>
        <p className="text-xs text-muted-foreground">{form.byWords}</p>
      </div>
      {form.sections.map((section) => (
        <div key={section.id} className="flex flex-col gap-2">
          {section.title ? <h6 className="text-sm font-medium">{section.title}</h6> : null}
          <dl className="grid min-w-0 gap-x-4 gap-y-2 sm:grid-cols-2">
            {section.items.map((item) => (
              <div key={item.id} className="min-w-0">
                <dt className="text-xs font-medium text-muted-foreground">{item.label}</dt>
                <dd className={cn("whitespace-pre-wrap break-words text-sm", item.words === null && "text-muted-foreground")}>
                  {/* Lo que dejó sin contestar la persona se dice como en su revisión: «No respondió». */}
                  {item.words ?? (form.source === "portal" ? "No respondió" : "Sin respuesta")}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      ))}
      {shownAddenda.length > 0 ? (
        <div className="flex flex-col gap-2 border-t pt-3">
          <h6 className="text-sm font-medium">{form.addendaTitle}</h6>
          <ul className="flex flex-col gap-2">
            {shownAddenda.map((addendum) => (
              <li key={addendum.id} className="text-sm">
                <p className="whitespace-pre-wrap break-words">{addendum.text}</p>
                {addendum.reason ? (
                  <p className="mt-0.5 whitespace-pre-wrap break-words text-xs text-muted-foreground">
                    Motivo: {addendum.reason}
                  </p>
                ) : null}
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {addendum.authorName ? `${addendum.authorName} · ` : ""}
                  <time dateTime={addendum.createdAt}>{whenWords(addendum.createdAt)}</time>
                </p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </article>
  )
}

/**
 * «Ver» de un formulario en la Historia: lo abre al lado, sin salir de ella, con
 * todas sus respuestas y sus adendas (el mismo que se abre desde Documentos).
 */
export function FormViewButton({ patientId, formId, title }: { patientId: string; formId: string; title: string }) {
  const [open, setOpen] = useState(false)
  const canWrite = usePermission("clinical.write")
  const queryClient = useQueryClient()
  // La misma consulta (y caché) que Documentos.
  const responses = useQuery({
    queryKey: ["form-responses", patientId],
    queryFn: () => fetchFormResponses({ patientId }),
    enabled: open,
  })
  const response = (responses.data?.data ?? []).find((row) => row.id === formId)
  const close = () => {
    setOpen(false)
    // Una adenda agregada ahí se lee también en la atención y en la Historia.
    for (const key of ["encounter", "timeline"]) void queryClient.invalidateQueries({ queryKey: [key, patientId] })
  }
  return (
    <>
      <Button type="button" variant="outline" size="sm" aria-label={`Ver ${title}`} onClick={() => setOpen(true)}>
        Ver
      </Button>
      {open ? (
        <DetailDrawer open title={title} onClose={close}>
          {responses.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {responses.error.message}
            </p>
          ) : response ? (
            <Suspense fallback={<LoadingState message="Cargando…" />}>
              <ResponseDetail
                key={response.id}
                response={response}
                canWrite={canWrite}
                onChanged={async () => {
                  await queryClient.invalidateQueries({ queryKey: ["form-responses", patientId] })
                }}
              />
            </Suspense>
          ) : responses.isPending ? (
            <LoadingState message="Cargando…" />
          ) : (
            <p className="text-sm text-muted-foreground">Ya no está disponible.</p>
          )}
        </DetailDrawer>
      ) : null}
    </>
  )
}

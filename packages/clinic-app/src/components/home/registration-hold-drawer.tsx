import { Button, cn, Table, TableBody, TableCell, TableHead, TableHeader, TableRow, toast } from "@odentia/ui"
import { DetailDrawer, internationalText, submitErrorMessage } from "@odentia/ui-patterns"
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query"
import { useState } from "react"
import { ApiError, apiFetch } from "../../lib/api"
import { activeOrgLocale } from "../../lib/locale"
import { ChoiceButtons } from "../choice-buttons"

interface HoldRow {
  key: "givenNames" | "familyName" | "phone" | "birthDate" | "document" | "allergies"
  label: string
  declared: string | null
  saved: string | null
  same: boolean
}

interface HoldView {
  taskId: string
  match: "documento" | "celular"
  ownerId: string
  ownerName: string
  ownerPatientId: string | null
  createdAt: string
  rows: HoldRow[]
  familyNameDiffers: boolean
}

/** Cada dato como se lee en la clínica: el celular con su prefijo y la fecha con su mes. */
function shown(row: HoldRow, value: string | null): string {
  if (!value) return "—"
  if (row.key === "phone") return internationalText(value)
  if (row.key === "birthDate") {
    return new Date(`${value}T12:00:00`).toLocaleDateString(activeOrgLocale(), { day: "numeric", month: "short", year: "numeric" })
  }
  return value
}

/** «Hace 3 min», en palabras, para decir cuándo se registró. */
function since(iso: string): string {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000))
  if (minutes < 1) return "hace un momento"
  if (minutes < 60) return `hace ${minutes} min`
  const hours = Math.round(minutes / 60)
  return hours < 24 ? `hace ${hours} h` : `hace ${Math.round(hours / 24)} d`
}

/**
 * «¿Es la misma persona?» (fase 4 del lienzo «Su enlace y el código QR»): lo
 * que escribió hoy quien se registró por el código QR, al lado de lo que ya
 * estaba. Se parecen por el mismo celular o documento, nunca solo por el
 * nombre; nada se une sin que recepción lo diga. Si los apellidos no
 * coinciden, se elige cuáles quedan.
 */
export function RegistrationHoldDrawer({ taskId, onClose }: { taskId: string | null; onClose: () => void }) {
  const queryClient = useQueryClient()
  const [familyName, setFamilyName] = useState<"saved" | "declared">("saved")
  const hold = useQuery({
    queryKey: ["registration-hold", taskId],
    queryFn: () => apiFetch<{ data: HoldView }>(`/api/tasks/${taskId}/registration`),
    enabled: !!taskId,
    retry: false,
  })
  const decide = useMutation({
    mutationFn: (same: boolean) =>
      apiFetch<{ data: { patientId: string } }>(`/api/tasks/${taskId}/registration`, {
        method: "POST",
        body: JSON.stringify(same && data?.familyNameDiffers ? { same, familyName } : { same }),
      }),
    onSuccess: (_result, same) => {
      toast.success(same ? `Listo: se completó la ficha de ${data?.ownerName ?? "la persona"}.` : "Listo: se registró como una persona nueva.")
      void queryClient.invalidateQueries({ queryKey: ["workspace-home"] })
      onClose()
    },
  })
  const data = hold.data?.data
  const family = data?.rows.find((row) => row.key === "familyName")
  const why = data?.match === "documento" ? "el mismo documento" : "el mismo celular"
  const problem = decide.error
    ? submitErrorMessage(decide.error)
    : hold.isError
      ? hold.error instanceof ApiError
        ? (hold.error.shape.message ?? "No se pudo abrir.")
        : "No se pudo abrir. Revisa tu conexión."
      : null
  return (
    <DetailDrawer
      open={!!taskId}
      onClose={onClose}
      title="¿Es la misma persona?"
      description={
        data
          ? `Se registró por el código QR ${since(data.createdAt)} y se parece a alguien que ya está en la clínica.`
          : "Se registró por el código QR y se parece a alguien que ya está en la clínica."
      }
      isLoading={hold.isPending && !!taskId}
      isSubmitting={decide.isPending}
      error={problem}
      showClose={false}
      actions={
        data ? (
          <>
            <Button type="button" variant="outline" disabled={decide.isPending} onClick={() => decide.mutate(false)}>
              Es otra persona
            </Button>
            <Button type="button" disabled={decide.isPending} onClick={() => decide.mutate(true)}>
              Es la misma persona
            </Button>
          </>
        ) : null
      }
    >
      {data ? (
        <div className="flex flex-col gap-5">
          <div className="overflow-hidden rounded-2xl border bg-card">
            <Table className="table-fixed">
              <caption className="sr-only">Lo que escribió hoy y lo que ya estaba</caption>
              <TableHeader>
                <TableRow>
                  <TableHead className="h-auto w-[6.5rem] px-4 py-2 text-xs text-muted-foreground">
                    <span className="sr-only">Dato</span>
                  </TableHead>
                  <TableHead className="h-auto px-2 py-2 text-xs whitespace-normal text-muted-foreground">Escribió hoy</TableHead>
                  <TableHead className="h-auto px-2 py-2 pr-4 text-xs whitespace-normal text-muted-foreground">{data.ownerName} · ya está</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.rows.map((row) => (
                  <TableRow key={row.key}>
                    <TableHead scope="row" className="h-auto px-4 py-2.5 font-normal text-muted-foreground">
                      {row.label}
                    </TableHead>
                    <TableCell className="px-2 py-2.5 break-words whitespace-normal">{shown(row, row.declared)}</TableCell>
                    <TableCell className={cn("px-2 py-2.5 pr-4 break-words whitespace-normal", !row.saved && "text-muted-foreground")}>
                      {row.saved ? shown(row, row.saved) : row.key === "allergies" ? "No preguntado" : "—"}
                      {row.same ? <span className="text-xs font-medium text-primary"> · igual</span> : null}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <p className="text-sm text-muted-foreground">Se parecen por {why}. Nunca se une solo por el nombre.</p>
          {data.familyNameDiffers && family ? (
            <div className="flex flex-col gap-2">
              <p className="text-sm font-medium">Los apellidos no coinciden: ¿cuáles quedan?</p>
              <ChoiceButtons
                aria-label="Apellidos que quedan"
                value={familyName}
                options={[
                  { value: "saved", label: `«${family.saved}», el que ya está` },
                  { value: "declared", label: `«${family.declared}», el nuevo` },
                ]}
                onChange={setFamilyName}
                columns={2}
              />
            </div>
          ) : null}
          <p className="rounded-2xl bg-muted/60 p-4 text-sm">
            Si es la misma persona, su ficha se completa con lo que faltaba y queda como paciente. Nada se borra. Si es otra, se registra como
            nueva{data.match === "documento" ? ", sin ese documento" : ""}.
          </p>
        </div>
      ) : null}
    </DetailDrawer>
  )
}

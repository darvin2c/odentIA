import { diagnosisCodeLabel } from "@odentia/clinical"
import { conditionLabel, SIGNED_ODONTOGRAM_PURPOSE_LABELS, surfaceLabel } from "@odentia/dental"
import { Badge, Button, buttonVariants } from "@odentia/ui"
import { Link } from "@tanstack/react-router"
import { useState } from "react"
import { OdontogramStudio } from "../../components/dental/odontogram-studio"
import {
  EncounterPeriodontalBlock,
  PeriodontalCaptureHost,
  periodontalBlockSummary,
  useEncounterPeriodontal,
} from "../../components/dental/periodontal/encounter-periodontal"
import { useOdontogram } from "../../lib/dental/use-odontogram"
import { dentalExamination } from "./examination"
import { ApiError } from "@odentia/clinic-app/lib/api"
import type { ClosingCheck, ClosingOdontogram } from "@odentia/clinic-app/lib/encounters"
import { type EncounterDetail, statusLabel } from "@odentia/clinic-app/lib/patients"
import type {
  EncounterBlockContext,
  ProductEncounterBlocks,
  ProductEncounterUi,
} from "@odentia/clinic-app/product/product-ui"

/** Lo dictado de una pieza se revisa en su bloque y entra como al tocarla (issue 109). */
const NO_FINDINGS = "Sin hallazgos en esta atención"

/**
 * Odontograma y Periodontograma en la atención en borrador (ADR 0033 y 0054).
 * La captura del periodontograma se monta sobre la atención, no en su bloque:
 * sobrevive a que la superficie lateral cambie de forma.
 */
function useDentalBlocks(ctx: EncounterBlockContext): ProductEncounterBlocks {
  const odontogram = useOdontogram(ctx.patientId, ctx.canRead)
  // El periodontograma de esta atención, si se empezó (issue 49).
  const periodontal = useEncounterPeriodontal(ctx.patientId, ctx.encounterId)
  const [capture, setCapture] = useState<string | null>(null)
  // odentIA siempre los trae en el detalle (`encounterDetailParts`).
  const findings = (ctx.detail.odontogramEntries ?? []).length
  return {
    blocks: [
      {
        key: "odontograma",
        title: "Odontograma",
        description: "Hallazgos por pieza sobre el odontograma del paciente.",
        summary: findings === 0 ? NO_FINDINGS : `${findings} ${findings === 1 ? "hallazgo" : "hallazgos"} en esta atención`,
        empty: findings === 0,
        dictation: { kinds: ["odontograma"], onlySuggested: NO_FINDINGS },
        content: (
          <div className="flex min-w-0 flex-col gap-3">
            {odontogram.isLoading && (
              <p className="text-sm text-muted-foreground">Cargando odontograma…</p>
            )}
            {odontogram.isError && (
              <p role="alert" className="text-sm text-destructive">
                {odontogram.error instanceof ApiError && odontogram.error.shape.message
                  ? odontogram.error.shape.message
                  : "No se pudo cargar el odontograma."}
              </p>
            )}
            {odontogram.data && (
              <OdontogramStudio
                patientId={ctx.patientId}
                state={odontogram.data.data}
                compact
                birthDate={ctx.birthDate}
                encounterId={ctx.encounterId}
                onChanged={ctx.onChanged}
                beforeWrite={ctx.flush}
                onPendingChange={ctx.onPendingChange}
                disabled={ctx.locked}
                readOnly={!ctx.canWrite}
              />
            )}
          </div>
        ),
      },
      {
        key: "periodontograma",
        title: "Periodontograma",
        description:
          "Sondaje de seis sitios por pieza, sangrado, placa y la clasificación de 2017. Queda fijo al firmar.",
        summary: periodontalBlockSummary(periodontal.item),
        empty: periodontal.item === null,
        content: (
          <EncounterPeriodontalBlock
            patientId={ctx.patientId}
            encounterId={ctx.encounterId}
            // No `locked`: la captura abierta no se cierra mientras otro bloque guarda.
            disabled={!ctx.writable}
            beforeWrite={ctx.flush}
            onChanged={ctx.onChanged}
            onCapture={setCapture}
          />
        ),
      },
    ],
    overlay: capture ? (
      <PeriodontalCaptureHost
        patientId={ctx.patientId}
        chartId={capture}
        onClose={() => {
          setCapture(null)
          void ctx.onChanged()
        }}
      />
    ) : null,
  }
}

/** «16, 26 y 36». */
function teethWords(teeth: number[]): string {
  if (teeth.length <= 1) return teeth.join("")
  return `${teeth.slice(0, -1).join(", ")} y ${teeth.at(-1)}`
}

/** «Hallazgos: lesión de caries dental en 16, 26 y 36». */
function findingsLine(odontogram: ClosingOdontogram): string | null {
  if (odontogram.findings.length === 0) return null
  const parts = odontogram.findings.map((group) => {
    const label = conditionLabel(group.condition)
    return `${label.charAt(0).toLowerCase()}${label.slice(1)} en ${teethWords(group.teeth)}`
  })
  return `Hallazgos: ${parts.join("; ")}`
}

/**
 * En el cierre: en clínicas de Perú, el odontograma que queda firmado con su
 * momento (fase 3, paso 5), y el periodontograma, que queda fijo al firmar; a
 * medias se firma como parcial.
 */
function DentalClosing({
  closing,
  pending,
  openBlock,
}: {
  closing: ClosingCheck
  pending: boolean
  openBlock: (key: string) => void
}) {
  const { odontogram, periodontal } = closing
  return (
    <>
      {odontogram ? (
        <div className="flex items-start gap-3 rounded-lg border p-3">
          <Badge variant="outline">{odontogram.shortName}</Badge>
          <div className="flex min-w-0 flex-col">
            <span className="font-medium">
              El odontograma queda firmado como «
              {SIGNED_ODONTOGRAM_PURPOSE_LABELS[odontogram.purpose]}»
            </span>
            {findingsLine(odontogram) ? (
              <span className="text-xs text-muted-foreground">{findingsLine(odontogram)}</span>
            ) : null}
          </div>
        </div>
      ) : null}
      {periodontal ? (
        periodontal.pending ? (
          <div className="flex flex-col gap-2 rounded-lg border border-warning/50 p-3">
            <span className="font-medium">
              Periodontograma sin terminar: falta {periodontal.pending}.
            </span>
            <span className="text-xs text-muted-foreground">
              Puede pasar en un control, si solo se mide un sector. Los índices se calculan con lo
              medido y el periodontograma dice «Parcial».
            </span>
            {/* «Seguir midiendo»: vuelve a la atención con el periodontograma abierto. */}
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="self-start"
              disabled={pending}
              onClick={() => openBlock("periodontograma")}
            >
              Seguir midiendo
            </Button>
          </div>
        ) : (
          <div className="rounded-lg border p-3">
            <span className="font-medium">
              Periodontograma: {periodontal.teeth} {periodontal.teeth === 1 ? "pieza" : "piezas"}
              {periodontal.implants
                ? ` y ${periodontal.implants} ${periodontal.implants === 1 ? "implante" : "implantes"}`
                : ""}
              .
            </span>{" "}
            <span className="text-muted-foreground">Queda fijo al firmar.</span>
          </div>
        )
      ) : null}
    </>
  )
}

/** El odontograma vinculado a la atención, con lo registrado; sin hallazgos no se muestra. */
function DentalDetailRecorded({ detail }: { detail: EncounterDetail }) {
  const entries = detail.odontogramEntries ?? []
  if (entries.length === 0) return null
  return (
    <section aria-label="Odontograma vinculado">
      <h4 className="mb-2 text-sm font-medium">Odontograma</h4>
      {(
        <ul className="flex flex-col gap-2">
          {entries.map((entry) => (
            <li key={entry.id} className="border-b pb-2 text-sm last:border-0">
              <p>
                Pieza {entry.toothNumber} · {conditionLabel(entry.condition)}
                {entry.surface ? ` · ${surfaceLabel(entry.surface)}` : ""} ·{" "}
                {statusLabel(entry.status)}
                {entry.diagnosisCode
                  ? ` · ${diagnosisCodeLabel(entry.diagnosisSystem, entry.diagnosisCode)}`
                  : ""}
              </p>
              {entry.note ? (
                <p className="whitespace-pre-wrap text-xs text-muted-foreground">{entry.note}</p>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** El periodontograma de la atención, al final de su detalle (issue 49). */
function DentalDetailEnd({ patientId, detail }: { patientId: string; detail: EncounterDetail }) {
  const { encounter } = detail
  const periodontal = useEncounterPeriodontal(patientId, encounter.id)
  if (!periodontal.item) return null
  return (
    <section aria-label="Periodontograma" className="flex flex-col gap-2 rounded-lg border p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col">
          <h4 className="text-sm font-medium">Periodontograma</h4>
          <p className="text-sm text-muted-foreground">
            {periodontalBlockSummary(periodontal.item)}
            {encounter.status === "finalizada" ? " · cerrado con la atención" : ""}
          </p>
        </div>
        <Link
          to="/patients/$patientId"
          params={{ patientId }}
          search={
            { tab: "periodontograma", periodontograma: periodontal.item.id } as {
              tab: "periodontograma"
            }
          }
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Ver
        </Link>
      </div>
      {encounter.status === "finalizada" ? (
        <p className="text-xs text-muted-foreground">
          Quedó fijo al firmar. Si hubo un error, explícalo en una adenda: el próximo
          periodontograma lo reemplaza.
        </p>
      ) : null}
    </section>
  )
}

/** odentIA en la atención: el examen de la boca, el odontograma y el periodontograma. */
export const dentalEncounter: ProductEncounterUi = {
  examination: dentalExamination,
  useBlocks: useDentalBlocks,
  Closing: (props) => <DentalClosing {...props} />,
  signLabel: (closing) => (closing?.periodontal?.pending ? "Firmar como parcial" : null),
  Detail: ({ patientId, detail, slot }) =>
    slot === "recorded" ? (
      <DentalDetailRecorded detail={detail} />
    ) : (
      <DentalDetailEnd patientId={patientId} detail={detail} />
    ),
}

import { CONSENT_DECLARATION, CONSENT_SECTION_LABELS, diagnosisCodeLabel } from "@odentia/clinical"
import { type ConsentDocument, consentSignatureWords } from "../../lib/clinical-forms"
import { activeOrgLocale } from "../../lib/locale"
import { FirmaView } from "./firma-pad"

function when(value: string | null | undefined): string {
  return value
    ? new Date(value).toLocaleString(activeOrgLocale(), { dateStyle: "long", timeStyle: "short" })
    : "—"
}

/**
 * Documento de consentimiento tal como se informa y firma: secciones fijas,
 * declaración, firmantes y estado. Lo usan la ficha y la hoja de impresión;
 * en pendiente deja los recuadros para firmar en papel.
 */
export function ConsentSheet({
  document,
  diagnosisDescription,
  patientLabel,
  paper = false,
}: {
  document: ConsentDocument
  diagnosisDescription?: string | null
  /** Línea de identificación del paciente (impresión). */
  patientLabel?: string
  /** Hoja para firma en papel: recuadros vacíos si aún no hay firma. */
  paper?: boolean
}): React.JSX.Element {
  const sections = document.sectionsSnapshot
  const pending = document.status === "pendiente"
  // Nivel real de la firma, siempre a la vista.
  const signatureWords = consentSignatureWords(document)
  return (
    <article className="flex flex-col gap-4 rounded-md border bg-white p-5 text-sm text-black">
      <header className="flex flex-col gap-1">
        <p className="text-xs font-medium tracking-wide text-neutral-600 uppercase">
          Consentimiento informado
        </p>
        <h3 className="text-base font-semibold">{document.titleSnapshot}</h3>
        <p className="text-xs text-neutral-600">
          Plantilla v{document.templateVersion}
          {document.procedureRef ? ` · ${document.procedureRef}` : ""}
        </p>
        {patientLabel ? <p>{patientLabel}</p> : null}
      </header>
      {sections ? (
        <>
          <Block title={CONSENT_SECTION_LABELS.procedure}>
            <p>{sections.procedure}</p>
          </Block>
          {document.diagnosisCode ? (
            <Block title={CONSENT_SECTION_LABELS.diagnosis}>
              <p>
                {diagnosisCodeLabel(document.diagnosisSystem, document.diagnosisCode)}
                {diagnosisDescription ? ` · ${diagnosisDescription}` : ""}
              </p>
            </Block>
          ) : null}
          <Block title={CONSENT_SECTION_LABELS.benefits}>
            <List items={sections.benefits} />
          </Block>
          <Block title={CONSENT_SECTION_LABELS.risks}>
            <List items={sections.risks} />
          </Block>
          <Block title={CONSENT_SECTION_LABELS.alternatives}>
            <List items={sections.alternatives} />
          </Block>
          <Block title={CONSENT_SECTION_LABELS.consequences}>
            <p>{sections.consequences}</p>
          </Block>
          {sections.notes ? (
            <Block title={CONSENT_SECTION_LABELS.notes}>
              <p>{sections.notes}</p>
            </Block>
          ) : null}
        </>
      ) : (
        <p className="whitespace-pre-wrap">{document.bodySnapshot}</p>
      )}
      <Block title="Declaración">
        <p>{CONSENT_DECLARATION}</p>
      </Block>
      <section className="grid gap-4 border-t pt-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium">
            {document.signerKind === "representante" ? "Representante legal" : "Paciente"}
          </p>
          {document.signatureData?.strokes ? (
            <FirmaView
              strokes={document.signatureData.strokes}
              label={`Firma de ${document.signerName}`}
            />
          ) : document.signatureMethod === "papel" ? (
            <p className="text-xs">Firmó la hoja en papel; su foto queda en Documentos.</p>
          ) : paper ? (
            <div className="aspect-[22/7] w-full rounded-md border" aria-hidden="true" />
          ) : null}
          <p className="text-xs">
            {pending
              ? "Nombre, documento y firma"
              : `${document.signerName}${document.signerDoc ? ` · ${document.signerDoc}` : ""}${
                  document.representativeRelation ? ` · ${document.representativeRelation}` : ""
                } · ${when(document.signedAt)}`}
          </p>
        </div>
        <div className="flex flex-col gap-1">
          <p className="text-xs font-medium">Profesional que informa</p>
          {document.professionalSignature?.strokes ? (
            <FirmaView
              strokes={document.professionalSignature.strokes}
              label={`Firma de ${document.informerName ?? "el profesional"}`}
            />
          ) : document.informerName ? (
            <p className="text-xs">
              Informó y resolvió sus dudas · firma con su perfil profesional.
            </p>
          ) : paper ? (
            <div className="aspect-[22/7] w-full rounded-md border" aria-hidden="true" />
          ) : null}
          <p className="text-xs">
            {document.informerName
              ? `${document.informerName}${document.informerTitle ? ` · ${document.informerTitle}` : ""}${
                  document.informerRegistration ? ` · ${document.informerRegistration}` : ""
                } · informó ${when(document.informedAt)}`
              : "Nombre, colegiatura y firma"}
          </p>
        </div>
        {document.witnessName ? (
          <p className="text-xs sm:col-span-2">
            Testigo: {document.witnessName}
            {document.witnessDoc ? ` · ${document.witnessDoc}` : ""}
          </p>
        ) : null}
      </section>
      {document.status === "revocado" ? (
        <section className="flex flex-col gap-1 border-t pt-3">
          <p className="font-semibold">Revocado</p>
          <p>
            {document.revokerName ?? "—"} · {when(document.revokedAt)} · Motivo:{" "}
            {document.revokeReason}
          </p>
          {document.revokeSignature?.strokes ? (
            <div className="max-w-xs">
              <FirmaView strokes={document.revokeSignature.strokes} label="Firma de quien revoca" />
            </div>
          ) : null}
        </section>
      ) : null}
      {document.status === "anulado" ? (
        <p className="border-t pt-3 font-semibold">
          Anulado {when(document.cancelledAt)} · {document.cancelReason}
        </p>
      ) : null}
      {signatureWords ? <p className="text-xs font-medium">{signatureWords}</p> : null}
      <p className="text-[11px] text-neutral-600">
        Firmas manuscritas capturadas como evidencia; no constituyen firma digital certificada.
        {document.pdfSha256 ? ` Huella SHA-256 del PDF: ${document.pdfSha256}` : ""}
      </p>
    </article>
  )
}

function Block({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-1">
      <h4 className="font-semibold">{title}</h4>
      {children}
    </section>
  )
}

function List({ items }: { items: string[] }) {
  return (
    <ul className="list-disc pl-5">
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ul>
  )
}

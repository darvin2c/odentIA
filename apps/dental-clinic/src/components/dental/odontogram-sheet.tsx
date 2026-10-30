import { brandedQrDataUrl } from "@odentia/clinic-app/lib/branded-qr"
import { formatDate } from "@odentia/clinic-app/lib/clinical-journey"
import { useOrgProfile } from "@odentia/clinic-app/lib/org"
import { useQuery } from "@tanstack/react-query"
import type { PrintEstablishment } from "../../lib/dental/odontogram"

/**
 * Las hojas del odontograma siguen en HTML por el gráfico de la norma; llevan el
 * mismo membrete, la misma hoja y la misma firma que los PDF de la clínica. El
 * papel es de la clínica: sin el color de la plataforma.
 */

/** Hoja del perfil de la clínica y márgenes; al imprimir solo sale la hoja. */
export function SheetPageStyle() {
  const sheet = useOrgProfile().data?.sheetSize === "Letter" ? "letter" : "A4"
  return (
    <style>{`@page { size: ${sheet}; margin: 11mm }
      @media print {
        body * { visibility: hidden; }
        .odontogram-sheet, .odontogram-sheet * { visibility: visible; }
        .odontogram-sheet { position: absolute; inset: 0 auto auto 0; width: 100%; border: 0; box-shadow: none; padding: 0; }
      }`}</style>
  )
}

/** «Dental Smile» → «DS». */
function initialsOf(name: string): string {
  return name
    .split(/\s+/)
    .map((word) => word.match(/\p{L}/u)?.[0]?.toLocaleUpperCase("es"))
    .filter(Boolean)
    .slice(0, 2)
    .join("")
}

/** El membrete: logo o iniciales, nombre, razón social, documento fiscal y sede. */
export function SheetLetterhead({ establishment }: { establishment: PrintEstablishment | null }) {
  const name = establishment?.tradeName || establishment?.legalName || "Establecimiento"
  const fiscal = [
    establishment?.legalName && establishment.legalName !== name ? establishment.legalName : null,
    establishment?.fiscalDocNumber
      ? [establishment.fiscalDocType, establishment.fiscalDocNumber].filter(Boolean).join(" ")
      : null,
  ]
    .filter(Boolean)
    .join(" · ")
  return (
    <header className="flex flex-wrap items-start justify-between gap-4 border-b border-gray-400 pb-3">
      <div className="flex min-w-0 items-center gap-3">
        {establishment?.logo ? (
          <img src={establishment.logo} alt="" className="size-12 shrink-0 object-contain" />
        ) : (
          <span
            aria-hidden
            className="flex size-12 shrink-0 items-center justify-center rounded border border-gray-400 text-base font-semibold"
          >
            {initialsOf(name)}
          </span>
        )}
        <div className="min-w-0">
          <p className="text-base font-semibold">{name}</p>
          {fiscal ? <p className="text-xs">{fiscal}</p> : null}
        </div>
      </div>
      <div className="text-right text-xs">
        {establishment?.branchName ? (
          <p className="font-medium">Sede {establishment.branchName}</p>
        ) : null}
        {establishment?.address ? <p>{establishment.address}</p> : null}
        {establishment?.phone ? <p>{establishment.phone}</p> : null}
      </div>
    </header>
  )
}

/**
 * «Firmado electrónicamente» con los datos congelados y el QR para comprobarlo
 * (ADR 0112): la misma firma de los PDF, sin línea para firmar a mano. Sin
 * dirección pública el papel sale sin QR y no promete nada.
 */
export function SheetSignature({
  name,
  title,
  registration,
  at,
  checkUrl,
}: {
  name: string
  title: string
  registration: string
  at: string
  checkUrl: string | null
}) {
  const qr = useQuery({
    queryKey: ["odontogram-check-qr", checkUrl],
    queryFn: () => brandedQrDataUrl(checkUrl as string),
    enabled: Boolean(checkUrl) && typeof window !== "undefined",
    staleTime: Number.POSITIVE_INFINITY,
  })
  return (
    <footer className="mt-4 flex items-center justify-between gap-4 border-t border-gray-400 pt-3 text-xs">
      <div className="min-w-0">
        <p className="font-semibold">Firmado electrónicamente</p>
        <p className="mt-1 text-sm font-medium">{name}</p>
        <p>{[title, registration].filter(Boolean).join(" · ")}</p>
        <p>{formatDate(at)}</p>
      </div>
      {checkUrl ? (
        <div className="flex shrink-0 items-center gap-2">
          <p className="max-w-32 text-right text-[10px]">
            Escanee para comprobar que sigue vigente
          </p>
          {qr.data ? (
            <img src={qr.data} alt="Código para comprobar este documento" className="size-20" />
          ) : (
            <span className="size-20" />
          )}
        </div>
      ) : null}
    </footer>
  )
}

import { useOrgProfile } from "@odentia/clinic-app/lib/org"
import { cn } from "@odentia/ui"
import type { PrintEstablishment } from "../../lib/dental/odontogram"

/**
 * La hoja neutra del odontograma de hoy sigue en HTML; lleva el mismo membrete y la
 * misma hoja que los PDF de la clínica (el firmado ya es un PDF, su papel emitido). El
 * papel es de la clínica: sin el color de la plataforma; con el de su marca solo en
 * la línea del membrete y el cuadro de iniciales, lejos del rojo y el azul de la norma.
 */

/**
 * Hoja del perfil de la clínica y márgenes; al imprimir solo sale la hoja. Con la hoja
 * membretada, sin margen: su diseño va de borde a borde y `SheetArticle` deja el del texto.
 */
export function SheetPageStyle({ establishment }: { establishment: PrintEstablishment | null }) {
  const sheet = useOrgProfile().data?.sheetSize === "Letter" ? "letter" : "A4"
  return (
    <style>{`@page { size: ${sheet}; margin: ${establishment?.sheet ? "0" : "11mm"} }
      @media print {
        body * { visibility: hidden; }
        /* La hoja se mide desde el borde del papel, no desde el área junto a la barra lateral
           (oculta, pero ocupa su ancho): ningún contenedor la posiciona. */
        :has(.odontogram-sheet) { position: static !important; }
        .odontogram-sheet, .odontogram-sheet * { visibility: visible; }
        .odontogram-sheet { position: absolute; inset: 0 auto auto 0; width: 100%; max-width: none; border: 0; border-radius: 0; box-shadow: none; padding: 0; }
      }`}</style>
  )
}

const PAPER =
  "odontogram-sheet mx-auto w-full max-w-[210mm] rounded-lg border bg-white text-sm text-black"

/**
 * El papel del odontograma. Con la hoja membretada (ADR 0182), su parte de arriba y la de
 * abajo van de borde a borde, como en los PDF: en pantalla, al principio y al final del
 * papel; al imprimir, en cada página. Ahí van fijas y la tabla les guarda su lugar en cada
 * página, porque el navegador repite su cabecera y su pie (con margen de página, Chrome
 * recorta lo que se pone en él). `className` es el del contenido: relleno y separación.
 */
export function SheetArticle({
  establishment,
  className,
  children,
}: {
  establishment: PrintEstablishment | null
  className: string
  children: React.ReactNode
}) {
  const sheet = establishment?.sheet
  if (!sheet) return <article className={cn(PAPER, className)}>{children}</article>
  const name = establishment?.tradeName || establishment?.legalName || "Establecimiento"
  return (
    <article className={cn(PAPER, "overflow-hidden print:overflow-visible")}>
      <img src={sheet.topBand} alt="" className="fixed top-0 left-0 hidden w-full print:block" />
      <img
        src={sheet.bottomBand}
        alt=""
        className="fixed bottom-0 left-0 hidden w-full print:block"
      />
      <table className="w-full border-collapse">
        <thead>
          <tr>
            <td className="p-0">
              <img src={sheet.topBand} alt={name} className="block h-auto w-full print:opacity-0" />
            </td>
          </tr>
        </thead>
        <tfoot>
          <tr>
            <td className="p-0">
              <img src={sheet.bottomBand} alt="" className="block h-auto w-full print:opacity-0" />
            </td>
          </tr>
        </tfoot>
        <tbody>
          <tr>
            <td className="p-0 align-top">
              <div className={cn(className, "print:px-[11mm]")}>{children}</div>
            </td>
          </tr>
        </tbody>
      </table>
    </article>
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

/**
 * El membrete: logo o iniciales, nombre, razón social, documento fiscal y sede. Con la
 * hoja membretada, su diseño (lo pone `SheetArticle`) dice quién es: aquí, la línea chica.
 */
export function SheetLetterhead({ establishment }: { establishment: PrintEstablishment | null }) {
  const name = establishment?.tradeName || establishment?.legalName || "Establecimiento"
  const sheet = establishment?.sheet
  if (sheet) {
    const line = [
      establishment?.legalName || name,
      establishment?.fiscalDocNumber
        ? [establishment.fiscalDocType, establishment.fiscalDocNumber].filter(Boolean).join(" ")
        : null,
      establishment?.branchName,
      establishment?.address,
      establishment?.phone,
    ]
      .filter(Boolean)
      .join(" · ")
    return line ? (
      <header>
        <p className="text-right text-xs">{line}</p>
      </header>
    ) : null
  }
  const fiscal = [
    establishment?.legalName && establishment.legalName !== name ? establishment.legalName : null,
    establishment?.fiscalDocNumber
      ? [establishment.fiscalDocType, establishment.fiscalDocNumber].filter(Boolean).join(" ")
      : null,
  ]
    .filter(Boolean)
    .join(" · ")
  const ink = establishment?.brandInk ?? null
  return (
    <header
      className={cn(
        "flex flex-wrap items-start justify-between gap-4 pb-3",
        ink ? "border-b-2" : "border-b border-gray-400",
      )}
      style={ink ? { borderColor: ink } : undefined}
    >
      <div className="flex min-w-0 items-center gap-3">
        {establishment?.logo ? (
          <img src={establishment.logo} alt="" className="size-12 shrink-0 object-contain" />
        ) : (
          <span
            aria-hidden
            className={cn(
              "flex size-12 shrink-0 items-center justify-center rounded text-base font-semibold",
              // Sin esto, el navegador no imprime el relleno del cuadro.
              ink ? "[print-color-adjust:exact]" : "border border-gray-400",
            )}
            style={ink ? { backgroundColor: ink, color: "#ffffff" } : undefined}
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
          <p className="font-medium">{establishment.branchName}</p>
        ) : null}
        {establishment?.address ? <p>{establishment.address}</p> : null}
        {establishment?.phone ? <p>{establishment.phone}</p> : null}
      </div>
    </header>
  )
}

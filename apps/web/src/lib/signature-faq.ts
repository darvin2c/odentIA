import type { FaqItem } from "./faq"

/**
 * La firma electrónica del consentimiento y lo que la respalda, igual en odentIA, latidIA y
 * vistIA; cambia solo quién la confirma. Se apoya en la Ley 27269 y en el D.S. 005-2021-SA,
 * art. 36.4 (manuscrita, digital «u otro medio que asegure la autentificación de identidad»),
 * y nombra solo las pruebas que la app ya guarda: el número de documento que se escribe y se
 * compara al firmar por el enlace (`signConsentByLink`), la confirmación del profesional
 * (`por_confirmar` en `consent-state.ts`), y la huella SHA-256 y el QR del PDF (`consent-pdf.ts`).
 * No afirma firma digital certificada, acreditación del MINSA ni conexión al RENHICE.
 */
export function signatureFaq(clinician: string): FaqItem {
  return {
    q: "¿La firma electrónica del consentimiento tiene validez?",
    a: `Sí. En el Perú, la Ley 27269 de Firmas y Certificados Digitales reconoce la firma electrónica, y el reglamento de telesalud (D.S. 005-2021-SA, art. 36.4) acepta el consentimiento con firma manuscrita, firma digital u otro medio que asegure la identidad de quien firma. La persona firma en la tablet de tu consulta, desde su celular con su enlace o en papel. Si firma desde su enlace, escribe el número de su documento y ${clinician} lo confirma en la cita. El PDF queda con su fecha y hora, su huella y un código QR para comprobar que no cambió.`,
  }
}

import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"
import { ApiError } from "../../lib/api"
import { QuestionnaireUnavailable } from "./link-steps"

const html = (error: unknown) => renderToStaticMarkup(<QuestionnaireUnavailable error={error} onRetry={() => {}} />)

// Revisión de la entrega 3: con el cuestionario ya enviado en otra pestaña, abrirlo decía «No pudimos
// abrir el cuestionario» con un «Reintentar» que no llevaba a ningún lado.
describe("el cuestionario que no se puede abrir", () => {
  it("si ya está enviado dice «Ya lo enviaste», como el envío, y no ofrece reintentar", () => {
    const page = html(
      new ApiError(409, {
        code: "ALREADY_SUBMITTED",
        message: "Ya lo enviaste: la clínica tiene las respuestas de la primera vez. Si quieres cambiar algo, díselo a tu odontólogo en la cita.",
      }),
    )
    expect(page).toContain("Ya lo enviaste")
    expect(page).toContain("La clínica tiene las respuestas de la primera vez. Si quieres cambiar algo, díselo a tu odontólogo en la cita.")
    expect(page).not.toContain("No pudimos abrir")
    expect(page).not.toContain("Reintentar")
    expect(page).not.toContain('role="alert"')
  })

  it("si lo envió otra persona que decide por el paciente, lo dice con sus palabras", () => {
    const page = html(new ApiError(409, { code: "ALREADY_SUBMITTED", message: "Ya está enviado: la clínica tiene las respuestas de la primera vez." }))
    expect(page).toContain("Ya está enviado")
    expect(page).not.toContain("Reintentar")
  })

  it("un fallo de verdad sigue diciendo que no se pudo abrir y deja reintentar", () => {
    const page = html(new TypeError("Failed to fetch"))
    expect(page).toContain("No pudimos abrir el cuestionario")
    expect(page).toContain("Reintentar")
    const expired = html(new ApiError(409, { code: "BOOKING_LINK_EXPIRED", message: "Este enlace ya no sirve. Responde el mensaje y te enviamos uno nuevo." }))
    expect(expired).toContain("Este enlace ya no sirve")
  })
})

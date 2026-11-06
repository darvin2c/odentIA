import { expect, it } from "vitest"
import { looksLikeQuestion, mayIdentifySomeone } from "./asked-text.js"

it("lo que puede ser el dato de una persona no se toma por una pregunta", () => {
  for (const text of ["987654321", "987 654 321", "+51 987-654-321", "DNI 45678912", "llamar al 987 654 321 mañana", "ana.paz@correo.pe", "Elena Pérez", "Elena Pérez Quispe", "historia 12.345"]) {
    expect(mayIdentifySomeone(text), text).toBe(true)
  }
  for (const text of ["¿Cómo bloqueo un horario?", "como cobro en dolares a un paciente", "quiero apagar a Sofi", "¿Dónde?", "no me deja reservar una cita los sábados", "¿Por qué Reportes dice S/ 5,685?"]) {
    expect(mayIdentifySomeone(text), text).toBe(false)
  }
})

it("una pregunta se reconoce por sus signos o por cómo empieza", () => {
  expect(looksLikeQuestion("¿qué es Agenda")).toBe(true)
  expect(looksLikeQuestion("donde veo las citas")).toBe(true)
  expect(looksLikeQuestion("Elena Pérez")).toBe(false)
})

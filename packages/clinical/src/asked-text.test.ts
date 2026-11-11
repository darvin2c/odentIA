import { expect, it } from "vitest"
import { looksLikeQuestion, mayIdentifySomeone, withoutPersonData } from "./asked-text.js"

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

it("lo que viaja a un modelo va sin cifras ni correos, o no viaja", () => {
  expect(withoutPersonData("¿Cómo bloqueo un horario?")).toBe("¿Cómo bloqueo un horario?")
  expect(withoutPersonData("como cobro 1200 mitad yape y mitad efectivo")).toBe("como cobro mitad yape y mitad efectivo")
  expect(withoutPersonData("¿por qué no le llega el correo a ana.paz@correo.pe?")).toBe("¿por qué no le llega el correo a")
  for (const text of ["987654321", "DNI 45678912", "llamar al 987 654 321 mañana", "Elena Pérez Quispe", "ana.paz@correo.pe", "  "]) {
    expect(withoutPersonData(text), text).toBeNull()
  }
})

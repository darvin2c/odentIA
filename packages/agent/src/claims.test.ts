import { describe, expect, it } from "vitest"
import { claimsOf } from "./claims"

describe("lo que la respuesta dice que se hizo (auditoría del ADR 0104)", () => {
  it("reconoce que el equipo lo verá o que se lo pasó, en los dos idiomas", () => {
    for (const text of [
      "Recepción revisará tu atención en Miraflores y te escribirá por aquí.",
      "Un profesional revisará tu consulta sobre el sangrado de encías.",
      "Ya se lo hice llegar al equipo.",
      "I'll pass this to the team so they can look into it.",
      "Our team is reviewing your question.",
    ]) {
      expect(claimsOf(text).team, text).toBe(true)
    }
  })

  it("reconoce que dice haber anotado algo", () => {
    for (const text of ["Ya dejé anotado que no puedes llamar.", "Tomé nota de que lo necesitas hoy.", "I've noted your request."]) {
      expect(claimsOf(text).note, text).toBe(true)
    }
  })

  it("reconoce que dice tener dónde avisarle: guardado, con el equipo o ya dejado (caso 17 de latidIA, 29-oct)", () => {
    for (const text of [
      "Ya guardé tu WhatsApp para que puedan avisarte.",
      "Para avisarte, guardé tu WhatsApp: 987 426 315.",
      "No puedo confirmarte si aplicamos la vacuna antirrábica; el equipo ya tiene tu consulta y tu WhatsApp para avisarte.",
      "El equipo ya tiene tu consulta y el WhatsApp que compartiste para avisarte.",
      "Una persona del equipo continuará la atención; ya recibimos tu WhatsApp y tu correo.",
      "Ya tenemos tu nombre y WhatsApp.",
      "Anoté tu WhatsApp para que puedan avisarte.",
      "Gracias, ya anoté su correo para avisarle.",
      "Ya compartiste tu WhatsApp para que el equipo pueda avisarte.",
      "Dejaste tu WhatsApp 987 426 318 para que puedan avisarte.",
      "Tu WhatsApp quedó registrado para avisarte si encuentran la bolsa.",
      "Dejé guardado ese número para que puedan avisarte por WhatsApp.",
      "Ya dejé tu WhatsApp para que el equipo pueda avisarte.",
      // El «sí» con tilde afirma (sin tildes sería el «si» de una condición); «conforme» y «ok», también.
      "Sí ya tenemos tu WhatsApp para avisarte.",
      "Conforme, ya tenemos tu WhatsApp.",
      "Ok, ya guardé tu WhatsApp.",
      "El equipo ya tiene tu consulta y el número de WhatsApp que compartiste.",
      "Te avisarán al WhatsApp que compartiste.",
      "Ya tenemos cómo avisarte por WhatsApp.",
      "I've saved your WhatsApp number.",
      "You're right — you already shared your number.",
      "Your WhatsApp is already saved.",
    ]) {
      expect(claimsOf(text).contact, text).toBe(true)
    }
  })

  it("pedirlo, decir que no se pudo o lo que depende de algo no es decir que lo tiene", () => {
    for (const text of [
      "Deja aquí tu WhatsApp o correo para que puedan avisarte.",
      "Por favor, deje su WhatsApp o correo para que puedan avisarle.",
      "¿Me compartes tus apellidos y tu WhatsApp para registrarte y avisarte?",
      "El WhatsApp que compartiste no se pudo usar para avisarte; déjanos otro número o tu correo aquí.",
      "No pudimos registrar ese número de WhatsApp.",
      "Si ya dejaste tu WhatsApp, no hace falta que lo repitas.",
      "¿Ya tenemos tu WhatsApp?",
      "If you've already shared your number, we'll use it.",
      "Do we have your email on file?",
      "Todavía no tenemos tu WhatsApp ni tu correo.",
      "Si necesitas hablar directamente con la sede, no tengo su teléfono disponible.",
      "Ya anoté tu número de documento.",
      "Ya dejé anotado que necesitas que retiren tu número.",
      // El aviso fijo de un pase y lo que responde guardar_contacto a quien ya conoce.
      "Recibimos tu mensaje. Una persona del equipo te va a responder y te avisamos por donde nos dejaste.",
      "Ya tenemos cómo avisarte.",
      "That email couldn't be saved; please check it or send us your WhatsApp number.",
      "I've noted your passport number.",
    ]) {
      expect(claimsOf(text).contact, text).toBe(false)
    }
  })

  it("lo demás no es decir que se hizo algo", () => {
    for (const text of [
      "¿Te reservo el jueves a las 10:00?",
      "Con gusto, María. Estamos atentos si quieres volver a escribirnos.",
      "La limpieza dura 45 minutos y cuesta S/ 79.",
      "Puedes dejarla en recepción de Miraflores, en Av. José Larco 345.",
      "Our team will be happy to see you on Thursday.",
    ]) {
      expect(claimsOf(text), text).toEqual({ team: false, note: false, contact: false })
    }
  })
})

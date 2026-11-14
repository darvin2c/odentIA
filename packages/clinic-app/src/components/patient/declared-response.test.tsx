import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { renderToStaticMarkup } from "react-dom/server"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { setOrgLocale } from "../../lib/locale"
import {
  declaredFormsOfEncounter,
  type FormResponse,
  isDeclaredUnreviewed,
  teamFormsOfEncounter,
} from "../../lib/clinical-forms"
import { ApiError } from "../../lib/api"
import { alreadySettled, correctionLostWords, DeclaredResponse, declaredAnswerText, reviewedLine, reviewedWords, sentWords } from "./declared-response"
import { ResponseDetail } from "./formularios-tab"

// Las fechas en el formato de la clínica, no en el de la máquina que corre la prueba (el CI está en inglés).
beforeAll(() => {
  setOrgLocale("es-PE", "America/Lima")
})
afterAll(() => {
  setOrgLocale(undefined, undefined)
})

vi.mock("../../lib/crm", () => ({
  usePermission: () => true,
  useMemberName: () => () => "Dra. Ana Torres",
  useOrgMembers: () => [],
}))

const sent: FormResponse = {
  id: "r1",
  organizationId: "org",
  templateId: "t1",
  templateVersion: 1,
  templateTitle: "Cuestionario de salud",
  templateSnapshot: {
    sections: [
      {
        id: "antes",
        title: "Antes de tu cita",
        fields: [
          { id: "motivo", label: "¿Por qué vienes a la consulta?", type: "texto_largo", required: true },
          { id: "dolor", label: "¿Cuánto te duele?", type: "escala", min: 0, max: 10 },
          { id: "anticoagulantes", label: "¿Tomas anticoagulantes o aspirina a diario?", type: "booleano" },
          { id: "algo", label: "¿Algo que quieras que sepamos antes de empezar?", type: "texto_largo" },
        ],
      },
    ],
  },
  patientId: "p1",
  encounterId: null,
  professionalUserId: null,
  status: "borrador",
  answers: { motivo: "Me duele la muela de abajo", dolor: 8, anticoagulantes: true },
  finalizedAt: null,
  source: "portal",
  submittedAt: "2026-11-13T19:27:00.000Z",
  submittedVia: "enlace",
  finalizedBy: null,
  respondent: { kind: "patient", name: "Marta Ríos", relation: null },
  editedByTeamAt: null,
  discardedAt: null,
  discardReason: null,
  createdAt: "2026-11-13T19:20:00.000Z",
  updatedAt: "2026-11-13T19:27:00.000Z",
}

function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}>{node}</QueryClientProvider>)
}

describe("lo que envió el paciente, para leer", () => {
  it("se muestra como texto: ningún campo para escribir encima, y la corrección y la revisión a la vista", () => {
    const page = render(<ResponseDetail response={sent} canWrite sex="F" onChanged={async () => {}} />)
    expect(page).toContain("Me duele la muela de abajo")
    expect(page).toContain("8 de 10")
    expect(page).toContain("No respondió")
    expect(page).not.toMatch(/<input|<textarea|role="radio"|role="switch"/)
    expect(page).toContain("Lo dijo ella · sin revisar")
    expect(page).toContain("Agregar una corrección")
    expect(page).toContain("Marcar como revisado")
    // Ya no se «completa» ni se «pasa a Antecedentes».
    expect(page).not.toContain("Pasar a Antecedentes")
    expect(page).not.toContain("Finalizar")
  })

  // La corrección se guarda con su botón, sin el `submit` del panel: el panel lateral sabe por
  // `useDraftSaved` si quedó algo a medias, y solo entonces pregunta al salir.
  it("la corrección a medias avisa al salir del panel; guardada, cancelada o sin texto, no", () => {
    expect(correctionLostWords("La alergia es a la amoxicilina", "")).toBe("Se pierde la corrección que escribiste y no guardaste.")
    expect(correctionLostWords("", "")).toBeNull()
    expect(correctionLostWords("   ", "  ")).toBeNull()
  })

  it("dice quién lo envió y por dónde, solo con lo que quedó guardado", () => {
    expect(sentWords(sent)).toMatch(/^Lo envió Marta Ríos desde su enlace el 13 nov, /)
    // Un solo punto al final, aunque la hora termine en «p. m.» (QA del 14 nov).
    expect(sentWords(sent)).toMatch(/m\.$/)
    expect(sentWords(sent)).not.toMatch(/\.\.$/)
    expect(sentWords({ ...sent, submittedVia: "portal" })).toContain("desde el portal")
    // Lo de antes, sin el canal guardado: no se afirma ninguno.
    expect(sentWords({ ...sent, submittedVia: null })).not.toMatch(/enlace|portal/)
    expect(sentWords({ ...sent, submittedAt: null })).toBe("Lo está respondiendo Marta Ríos: todavía no lo envió.")
    const byMother = render(
      <DeclaredResponse
        response={{ ...sent, respondent: { kind: "representative", name: "Carla Paz", relation: "madre" } }}
        canWrite
        sex="M"
      />,
    )
    expect(byMother).toContain("Lo envió Carla Paz desde su enlace")
    expect(byMother).toContain("Lo dijo su madre, Carla · sin revisar")
    // Sin sexo registrado no se supone ninguno.
    expect(render(<DeclaredResponse response={sent} canWrite />)).toContain("Lo dijo la persona · sin revisar")
  })

  it("revisado, sigue a la vista con quién y cuándo, y aún se le agrega una corrección", () => {
    const reviewed = { ...sent, status: "finalizado", finalizedAt: "2026-11-14T15:00:00.000Z", finalizedBy: "u1" } as FormResponse
    expect(isDeclaredUnreviewed(sent)).toBe(true)
    expect(isDeclaredUnreviewed(reviewed)).toBe(false)
    const page = render(<DeclaredResponse response={reviewed} canWrite sex="F" />)
    expect(page).toContain("Lo revisó Dra. Ana Torres, 14 nov")
    expect(page).toContain("Agregar una corrección")
    expect(page).not.toContain("Marcar como revisado")
    // Sin permiso de escribir en la historia, solo se lee.
    expect(render(<DeclaredResponse response={sent} canWrite={false} sex="F" />)).not.toContain("Marcar como revisado")
    // Lo que el paciente aún no envió no se revisa ni se corrige.
    const draft = render(<DeclaredResponse response={{ ...sent, submittedAt: null }} canWrite sex="F" />)
    expect(draft).toContain("Sin enviar")
    expect(draft).not.toContain("Marcar como revisado")
    expect(draft).not.toContain("Agregar una corrección")
  })

  it("en la atención, lo revisado se ve una sola vez: arriba, y no otra vez en la lista de documentos", () => {
    const reviewedHere = { ...sent, id: "r2", status: "finalizado", finalizedAt: "2026-11-14T15:00:00.000Z", encounterId: "e1" } as FormResponse
    const reviewedElsewhere = { ...reviewedHere, id: "r3", encounterId: "e9" } as FormResponse
    const teamForm = { ...sent, id: "r4", source: "staff", submittedAt: null, encounterId: "e1", respondent: null } as FormResponse
    const all = [sent, reviewedHere, reviewedElsewhere, teamForm]
    // Arriba: lo que sigue sin revisar y lo que se revisó en esta atención.
    expect(declaredFormsOfEncounter(all, "e1").map((form) => form.id)).toEqual(["r1", "r2"])
    // Lo que ya estaba a la vista y otra persona revisó sin ligarlo a esta atención no desaparece
    // de golpe: sigue ahí para decir quién lo revisó (QA del 14 nov, H1 de desarrollo).
    expect(declaredFormsOfEncounter(all, "e1", new Set(["r3"])).map((form) => form.id)).toEqual(["r1", "r2", "r3"])
    // En la lista de documentos de la atención, solo lo que llena el equipo.
    expect(teamFormsOfEncounter(all, "e1").map((form) => form.id)).toEqual(["r4"])
  })

  it("nada queda sin salida: lo enviado y lo que dejó a medias se descartan con su motivo", () => {
    // Un envío repetido o de otra persona: «Descartar…» junto a revisar y corregir.
    expect(render(<DeclaredResponse response={sent} canWrite sex="F" />)).toContain("Descartar…")
    // Un borrador que el paciente abandonó: es su única acción.
    expect(render(<DeclaredResponse response={{ ...sent, submittedAt: null }} canWrite sex="F" />)).toContain("Descartar…")
    // Revisado ya no se descarta (se corrige), y sin permiso de escribir no se ofrece.
    const reviewed = { ...sent, status: "finalizado", finalizedAt: "2026-11-14T15:00:00.000Z", finalizedBy: "u1" } as FormResponse
    expect(render(<DeclaredResponse response={reviewed} canWrite sex="F" />)).not.toContain("Descartar…")
    expect(render(<DeclaredResponse response={sent} canWrite={false} sex="F" />)).not.toContain("Descartar…")
  })

  it("lo que el equipo cambió antes de que se protegiera no se presenta como intacto", () => {
    const edited = render(
      <DeclaredResponse response={{ ...sent, editedByTeamAt: "2026-11-13T20:10:00.000Z" }} canWrite sex="F" />,
    )
    expect(edited).toContain("El equipo cambió estas respuestas el 13 nov")
    expect(edited).toContain("lo que envió no se conserva")
    // Ni «es lo que ella escribió» ni «lo dijo ella»: ya no se sabe.
    expect(edited).not.toContain("Es lo que ella escribió y no se cambia")
    expect(edited).not.toContain("Lo dijo ella · sin revisar")
    expect(edited).toContain("Sin revisar")
    // Lo que nadie tocó sí se dice intacto.
    const intact = render(<DeclaredResponse response={sent} canWrite sex="F" />)
    expect(intact).toContain("Es lo que ella escribió y no se cambia")
    expect(intact).not.toContain("El equipo cambió estas respuestas")
  })

  it("el aviso dice lo que pasó de verdad, y la frase de alergias sale solo si la plantilla las pregunta", () => {
    expect(reviewedWords(sent, [])).toBe("Revisado. Nada pasó a Antecedentes: sus respuestas quedan aquí y en Documentos.")
    expect(render(<DeclaredResponse response={sent} canWrite sex="F" />)).not.toContain("las alergias que escribió pasan")
    const withAllergies: FormResponse = {
      ...sent,
      templateSnapshot: {
        sections: [
          {
            id: "antes",
            title: "Antes de tu cita",
            fields: [
              ...sent.templateSnapshot.sections[0]!.fields,
              { id: "alergias", label: "¿A qué eres alérgica?", type: "texto_largo", definition: "AllergyIntolerance.code" },
            ],
          },
        ],
      },
    }
    expect(render(<DeclaredResponse response={withAllergies} canWrite sex="F" />)).toContain("las alergias que escribió pasan")
    expect(reviewedWords(withAllergies, ["Penicilina", "Látex"])).toBe(
      "Revisado. Pasó a Antecedentes: Penicilina y Látex, como alergia que dijo y falta confirmar.",
    )
    expect(reviewedWords(withAllergies, [])).toContain("Nada nuevo pasó a Antecedentes")
  })

  it("cada respuesta se lee en palabras", () => {
    const field = sent.templateSnapshot.sections[0]!.fields
    expect(declaredAnswerText(field[2]!, true)).toBe("Sí")
    expect(declaredAnswerText(field[2]!, false)).toBe("No")
    expect(declaredAnswerText(field[1]!, 8)).toBe("8 de 10")
    expect(declaredAnswerText(field[0]!, "")).toBe("No respondió")
    expect(declaredAnswerText({ id: "x", label: "Hábitos", type: "opcion_multiple" }, ["Fuma", "Bruxismo"])).toBe("Fuma, Bruxismo")
  })
})

// QA del 14 nov (H1 de desarrollo): una pestaña vieja decía «No se pudo… El formulario ya está
// finalizado Si no tiene arreglo, puedes descartarlo», y el servidor no deja descartar lo revisado.
describe("la pestaña que se quedó vieja", () => {
  const byLuis = { status: "finalizado", finalizedBy: "u2", finalizedAt: "2026-11-14T05:11:00.000Z", discardedAt: null } as const
  const name = () => "Dr. Luis Prado"
  it("dice quién lo revisó mientras la tenía abierta, con la hora", () => {
    expect(reviewedLine(byLuis, name, true)).toMatch(/^Ya lo revisó Dr\. Luis Prado el 14 nov, 12:11/)
    expect(reviewedLine(byLuis, name)).toBe("Lo revisó Dr. Luis Prado, 14 nov")
  })
  it("el «ya está finalizado» del servidor se toma como «ya lo revisaron», no como un fallo con salida", () => {
    expect(alreadySettled(new ApiError(409, { code: "FINALIZED", message: "El formulario ya está finalizado" }))).toBe(true)
    expect(alreadySettled(new ApiError(409, { code: "NOT_SUBMITTED", message: "…" }))).toBe(false)
    expect(alreadySettled(new Error("red"))).toBe(false)
  })
  it("ya revisado no ofrece «Descartar…»; la línea de quién lo revisó recibe el foco", () => {
    const page = render(<DeclaredResponse response={{ ...sent, ...byLuis } as FormResponse} canWrite sex="F" />)
    expect(page).not.toContain("Descartar…")
    expect(page).toMatch(/<p tabindex="-1"[^>]*><span[^>]*>Lo revisó Dr|<p tabindex="-1"[^>]*>.*Lo revisó/)
  })
})

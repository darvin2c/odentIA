import { describe, expect, it } from "vitest"
import { ariadnaChatsStateWords } from "./arm/ariadna-chats"
import { handoverTitle, kairosChatState, sentLineWords } from "./arm/chat-api"
import { absenceClashDoneWords, absenceClashOf } from "./arm/kairos-items"
import { kairosSellsStateWords } from "./arm/kairos-sells"
import {
  absenceRange,
  absenceWords,
  conflictWords,
  hoursSummary,
  minutesToTime,
  scheduleLineWords,
  timeToMinutes,
} from "./staff-schedule"

/** Horario, ausencias y Kairós en pantalla: lo que se dice y lo que se manda. */

const weekdays = [1, 2, 3, 4, 5]
const split = weekdays.flatMap((weekday) => [
  { weekday, startMin: 540, endMin: 780 },
  { weekday, startMin: 900, endMin: 1080 },
])

describe("el horario para presentaciones", () => {
  it("junta los días seguidos con las mismas franjas", () => {
    expect(hoursSummary(split)).toBe("Lun a vie, 9:00 a 13:00 y 15:00 a 18:00")
    expect(hoursSummary([...split, { weekday: 6, startMin: 600, endMin: 720 }])).toBe(
      "Lun a vie, 9:00 a 13:00 y 15:00 a 18:00 · Sáb, 10:00 a 12:00",
    )
    // Lunes y miércoles no son seguidos: van aparte.
    expect(
      hoursSummary([
        { weekday: 1, startMin: 600, endMin: 1020 },
        { weekday: 3, startMin: 600, endMin: 1020 },
      ]),
    ).toBe("Lun, 10:00 a 17:00 · Mié, 10:00 a 17:00")
    // El domingo (0) va al final de la semana.
    expect(hoursSummary([{ weekday: 0, startMin: 600, endMin: 660 }, split[0]!])).toBe(
      "Lun, 9:00 a 13:00 · Dom, 10:00 a 11:00",
    )
  })

  it("lee y escribe las horas como el selector", () => {
    expect(minutesToTime(540)).toBe("09:00")
    expect(timeToMinutes("15:30")).toBe(930)
  })

  it("la línea de Equipo dice si Kairós no le agenda y su ausencia", () => {
    const now = new Date("2026-11-14T15:00:00Z")
    expect(
      scheduleLineWords(
        { userId: "u", name: "Ana", meetingUrl: null, hours: [], absences: [] },
        now,
      ),
    ).toEqual(["Sin horario para presentaciones: Kairós no le agenda", "Sin sala de videollamada"])
    const lines = scheduleLineWords(
      {
        userId: "u",
        name: "Ana",
        meetingUrl: "https://meet.example.test/ana",
        hours: split,
        absences: [
          {
            id: "a",
            userId: "u",
            startsAt: "2026-11-16T05:00:00.000Z",
            endsAt: "2026-11-19T05:00:00.000Z",
            reason: "Vacaciones",
          },
        ],
      },
      now,
    )
    expect(lines[1]).toBe("Con su sala de videollamada")
    expect(lines[2]).toBe("Ausente: Del lun 16 nov al mié 18 nov · Vacaciones")
  })
})

describe("las ausencias", () => {
  it("días completos van de medianoche a medianoche de Lima, con el último incluido", () => {
    const range = absenceRange({
      kind: "dias",
      fromDay: "2026-11-16",
      toDay: "2026-11-18",
      day: "",
      startTime: "",
      endTime: "",
      reason: "",
    })
    expect(range).toEqual({
      startsAt: "2026-11-16T05:00:00.000Z",
      endsAt: "2026-11-19T05:00:00.000Z",
    })
    expect(absenceWords({ ...range, reason: null })).toBe("Del lun 16 nov al mié 18 nov")
    expect(
      absenceWords({
        ...absenceRange({
          kind: "dias",
          fromDay: "2026-11-16",
          toDay: "",
          day: "",
          startTime: "",
          endTime: "",
          reason: "",
        }),
        reason: "Médico",
      }),
    ).toBe("El lun 16 nov · Médico")
  })

  it("unas horas son de ese día", () => {
    const range = absenceRange({
      kind: "horas",
      fromDay: "",
      toDay: "",
      day: "2026-11-17",
      startTime: "15:00",
      endTime: "17:00",
      reason: "",
    })
    expect(range).toEqual({
      startsAt: "2026-11-17T20:00:00.000Z",
      endsAt: "2026-11-17T22:00:00.000Z",
    })
    expect(absenceWords({ ...range, reason: null })).toBe("El mar 17 nov, de 15:00 a 17:00")
  })

  it("lo que choca se dice con su número y dónde se decide", () => {
    expect(conflictWords(2, true)).toBe("Choca con 2 presentaciones: quedan en Hoy para decidir")
    expect(conflictWords(1, false)).toBe(
      "Choca con 1 presentación: queda en Hoy de Administración para decidir",
    )
  })

  it("la tarjeta de Hoy lee el ítem y dice a quién se pasaron", () => {
    const item = {
      payload: {
        userName: "Sofía Soporte",
        tasks: [
          {
            taskId: "t1",
            clientId: "c1",
            clientName: "Sonrisa Total",
            startsAt: "2026-11-17T15:00:00Z",
          },
          { taskId: 3 },
        ],
        candidates: [{ userId: "ada", name: "Ada Administradora" }],
      },
    }
    const clash = absenceClashOf(item)
    expect(clash.tasks).toHaveLength(1)
    expect(clash.candidates).toEqual([{ userId: "ada", name: "Ada Administradora" }])
    expect(absenceClashDoneWords(item, { choice: "pasar", toUserId: "ada" })).toBe(
      "Pasó a Ada: le queda en Hoy y a la clínica se le avisa con quién será",
    )
    expect(absenceClashDoneWords(item, { choice: "otra_hora" })).toBe(
      "Kairós le escribe a la clínica para pedirle otra hora",
    )
  })
})

describe("Kairós en los chats", () => {
  const base = {
    handledByKairos: false,
    kairosAvailable: true,
    kairosPausedAt: null,
    kairosPausedBy: null,
    kairosHandover: null,
    handledByAriadna: false,
    ariadnaAvailable: false,
  }

  it("dice quién atiende la conversación", () => {
    expect(kairosChatState({ ...base, handledByKairos: true }, "yo")).toEqual({
      kind: "kairos",
      agent: "Kairós",
    })
    const paused = { ...base, kairosPausedAt: "2026-11-14T15:00:00Z" }
    expect(
      kairosChatState({ ...paused, kairosPausedBy: { userId: "yo", name: "Ada A" } }, "yo"),
    ).toMatchObject({ kind: "persona", words: expect.stringContaining("Lo atiendes tú") })
    expect(
      kairosChatState({ ...paused, kairosPausedBy: { userId: "otra", name: "Ana Ruiz" } }, "yo"),
    ).toMatchObject({ kind: "persona", words: expect.stringContaining("Lo atiende Ana") })
    expect(
      kairosChatState(
        {
          ...paused,
          kairosHandover: {
            at: paused.kairosPausedAt,
            why: "Pidió un descuento",
            agent: "kairos",
            to: null,
          },
        },
        "yo",
      ),
    ).toEqual({
      kind: "paso",
      agent: "Kairós",
      why: "Pidió un descuento",
      to: null,
      canReturn: true,
    })
    // Apagado o clínica con su app, y nadie la pausó: Kairós no tiene nada que ver.
    expect(kairosChatState({ ...base, kairosAvailable: false }, "yo")).toBeNull()
  })

  it("lo que escribió Kairós va con su nombre", () => {
    expect(
      sentLineWords({
        kind: "salio",
        id: "o",
        at: "2026-11-14T15:00:00Z",
        body: "Hola",
        status: "enviado",
        template: null,
        adminOnly: true,
        createdBy: null,
        sentAt: "2026-11-14T15:00:00Z",
        byKairos: true,
        byAriadna: false,
      }),
    ).toBe("Kairós · 10:00 · Salió")
  })

  it("Ariadna atiende la clínica con su app y dice a quién la pasó", () => {
    const clinic = { ...base, kairosAvailable: false, ariadnaAvailable: true }
    expect(kairosChatState({ ...clinic, handledByAriadna: true }, "yo")).toEqual({
      kind: "kairos",
      agent: "Ariadna",
    })
    const paused = { ...clinic, kairosPausedAt: "2026-11-14T15:00:00Z" }
    expect(
      kairosChatState({ ...paused, kairosPausedBy: { userId: "yo", name: "Ada A" } }, "yo"),
    ).toMatchObject({
      kind: "persona",
      agent: "Ariadna",
      words: "Lo atiendes tú: Ariadna no responde sola aquí.",
    })
    const handed = (to: string) =>
      kairosChatState(
        {
          ...paused,
          kairosHandover: { at: paused.kairosPausedAt, why: "Dijo que sí", agent: "ariadna", to },
        },
        "yo",
      )
    const soporte = handed("soporte")
    expect(soporte).toEqual({
      kind: "paso",
      agent: "Ariadna",
      why: "Dijo que sí",
      to: "soporte",
      canReturn: true,
    })
    if (soporte?.kind !== "paso") throw new Error("paso")
    expect(handoverTitle(soporte)).toBe("Ariadna se la pasó a Soporte")
    const admin = handed("administracion")
    if (admin?.kind !== "paso") throw new Error("paso")
    expect(handoverTitle(admin)).toBe("Ariadna se la pasó a Administración")
    const patient = handed("paciente")
    if (patient?.kind !== "paso") throw new Error("paso")
    expect(handoverTitle(patient)).toBe("Ariadna cree que escribe un paciente")
    expect(
      sentLineWords({
        kind: "salio",
        id: "o",
        at: "2026-11-14T15:00:00Z",
        body: "Hola",
        status: "enviado",
        template: null,
        adminOnly: false,
        createdBy: null,
        sentAt: "2026-11-14T15:00:00Z",
        byKairos: true,
        byAriadna: true,
      }),
    ).toBe("Ariadna · 10:00 · Salió")
  })

  it("el interruptor de Ariadna dice quién la dejó así", () => {
    expect(ariadnaChatsStateWords({ enabled: false, updatedAt: null, updatedBy: null })).toBe(
      "Apagada",
    )
    expect(
      ariadnaChatsStateWords({
        enabled: true,
        updatedAt: "2026-11-14T15:05:00Z",
        updatedBy: { userId: "ada", name: "Ada Administradora" },
      }),
    ).toMatch(/^Prendida por Ada el /)
  })

  it("el interruptor dice quién lo dejó así", () => {
    expect(kairosSellsStateWords({ enabled: false, updatedAt: null, updatedBy: null })).toBe(
      "Apagado",
    )
    expect(
      kairosSellsStateWords({
        enabled: true,
        updatedAt: "2026-11-14T15:05:00Z",
        updatedBy: { userId: "ada", name: "Ada Administradora" },
      }),
    ).toBe("Prendido por Ada el sáb 14 nov, 10:05")
  })
})

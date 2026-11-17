import { describe, expect, it } from "vitest"
import { kairosChatState, sentLineWords } from "./arm/chat-api"
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
  }

  it("dice quién atiende la conversación", () => {
    expect(kairosChatState({ ...base, handledByKairos: true }, "yo")).toEqual({ kind: "kairos" })
    const paused = { ...base, kairosPausedAt: "2026-11-14T15:00:00Z" }
    expect(
      kairosChatState({ ...paused, kairosPausedBy: { userId: "yo", name: "Ada A" } }, "yo"),
    ).toMatchObject({ kind: "persona", words: expect.stringContaining("Lo atiendes tú") })
    expect(
      kairosChatState({ ...paused, kairosPausedBy: { userId: "otra", name: "Ana Ruiz" } }, "yo"),
    ).toMatchObject({ kind: "persona", words: expect.stringContaining("Lo atiende Ana") })
    expect(
      kairosChatState(
        { ...paused, kairosHandover: { at: paused.kairosPausedAt, why: "Pidió un descuento" } },
        "yo",
      ),
    ).toEqual({ kind: "paso", why: "Pidió un descuento", canReturn: true })
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
        deliveredAt: null,
        readAt: null,
        failedAt: null,
        failedWhy: null,
        basis: [],
        files: [],
      }),
    ).toBe("Kairós · 10:00 · Salió")
  })

  it("WhatsApp dice si llegó y si lo leyó", () => {
    const sent = {
      kind: "salio" as const,
      id: "o",
      at: "2026-11-14T15:00:00Z",
      body: "Hola",
      status: "enviado",
      template: null,
      adminOnly: true,
      createdBy: { userId: "u", name: "Ana Ruiz" },
      sentAt: "2026-11-14T15:00:00Z",
      byKairos: false,
      deliveredAt: "2026-11-14T15:00:05Z",
      readAt: null,
      failedAt: null as string | null,
      failedWhy: null as string | null,
      basis: [],
      files: [],
    }
    expect(sentLineWords(sent)).toBe("Ana Ruiz · 10:00 · Entregado")
    expect(sentLineWords({ ...sent, readAt: "2026-11-14T15:02:00Z" })).toBe(
      "Ana Ruiz · 10:00 · Leído",
    )
    expect(sentLineWords({ ...sent, status: "incierto" })).toBe(
      "Ana Ruiz · 10:00 · No se sabe si salió",
    )
    // Salió, pero WhatsApp dijo después que no llegó: eso manda sobre «Entregado».
    expect(sentLineWords({ ...sent, failedAt: "2026-11-14T15:01:00Z", failedWhy: "131053" })).toBe(
      "Ana Ruiz · 10:00 · No llegó",
    )
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

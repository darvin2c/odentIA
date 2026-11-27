/*
 * ---------- El control dicho por la edad del paciente (revisión del 26 nov) ----------
 *
 * «Su próximo control a los dos años», dicho de un niño de 18 meses, es cuando cumpla dos años: Clío
 * lo contaba desde hoy. Con su fecha de nacimiento y una frase de edad («a los dos años», «cuando
 * cumpla tres años»), el servidor propone esa fecha y lo dice; «en dos años» o «dentro de dos años» siguen
 * contándose desde hoy, y una edad que ya pasó también (un adulto «a los seis meses»). Es una
 * propuesta: el profesional la ve en la tarjeta y la cambia.
 */

const NUMBERS: Record<string, number> = {
  un: 1, uno: 1, una: 1, dos: 2, tres: 3, cuatro: 4, cinco: 5, seis: 6, siete: 7, ocho: 8, nueve: 9, diez: 10,
  once: 11, doce: 12, trece: 13, catorce: 14, quince: 15, "dieciséis": 16, dieciseis: 16, diecisiete: 17, dieciocho: 18,
}

/**
 * «a los dos años», «al cumplir los 3 años», «cuando cumpla dos años», «a los seis meses»; no «a los
 * dos años de la cirugía» ni «al cumplir los seis meses del tratamiento» (eso cuenta desde otra cosa),
 * sí «a los dos años de edad». La unidad se tiene que decir: «cuando cumpla dos» no dice si son años o
 * meses y no se supone (revisión de código del 26 nov: así se volvía su sexto cumpleaños).
 */
const AGE_SAID =
  /\b(a los|al cumplir(?: los)?|cuando cumpla(?: los)?)\s+(\d{1,2}|un|uno|una|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|diecis[eé]is|diecisiete|dieciocho)\s+(a[ñn]os?|meses|mes)\b(?!\s+(?:de|del|despu[eé]s|luego)\b(?!\s+edad))/u

/** AAAA-MM-DD más esos años o meses; el 29 de febrero, o el 31 de un mes corto, cae el último día del mes. */
function addToDay(day: string, months: number): string {
  const [year, month, date] = day.split("-").map(Number) as [number, number, number]
  const total = year * 12 + (month - 1) + months
  const targetYear = Math.floor(total / 12)
  const targetMonth = (total % 12) + 1
  const last = new Date(Date.UTC(targetYear, targetMonth, 0)).getUTCDate()
  return `${String(targetYear).padStart(4, "0")}-${String(targetMonth).padStart(2, "0")}-${String(Math.min(date, last)).padStart(2, "0")}`
}

export interface ControlByAge {
  /** El instante que se propone: ese día a mediodía UTC, que es el mismo día en toda zona de América. */
  dueAt: string
  day: string
  /** La frase de edad tal como se dijo. */
  said: string
  /** «2 años», «6 meses». */
  age: string
}

/**
 * La fecha del control por su edad, si la frase lo dice así y esa edad aún no llegó; null si no (se
 * queda la que propuso Clío, desde hoy).
 */
export function controlByAge(said: string | undefined, patient: { birthDate?: string | null; today?: string | null }): ControlByAge | null {
  if (!said || !patient.birthDate || !patient.today) return null
  const found = AGE_SAID.exec(said.toLocaleLowerCase("es"))
  if (!found?.[2]) return null
  const count = /^\d+$/.test(found[2]) ? Number(found[2]) : NUMBERS[found[2]]
  const unit = found[3]
  if (!count || !unit) return null
  const months = unit.startsWith("mes") ? count : count * 12
  const day = addToDay(patient.birthDate.slice(0, 10), months)
  if (day <= patient.today) return null
  const age = unit.startsWith("mes") ? `${count} ${count === 1 ? "mes" : "meses"}` : `${count} ${count === 1 ? "año" : "años"}`
  return { dueAt: `${day}T12:00:00.000Z`, day, said: found[0], age }
}

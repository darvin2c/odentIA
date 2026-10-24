// Las preguntas de la demostración de Argos (lienzo del paso 3, tableros Argos y Reportes). Son datos
// de una clínica de ejemplo (Clínica Sonrisa Norte, en soles), no precios de odentIA.
import type { ArgosQuestion } from "../components/agents/ArgosDemo"

export const ARGOS_NO_SHOWS: ArgosQuestion = {
  label: "Inasistencias por profesional",
  q: "¿Qué profesional tiene más inasistencias?",
  answer: "El Dr. Ríos: 18 % este mes (9 de 50 citas). En toda la clínica fue 11 %.",
  how: "citas a las que el paciente no vino ÷ citas que ya pasaron. Octubre, todas las sedes.",
  consulting: "Consultando las cifras de Reportes",
  bars: [
    ["Dr. Ríos", 18, "18 %"],
    ["Dra. Paredes", 9, "9 %"],
    ["Dra. Vega", 6, "6 %"],
  ],
}

export const ARGOS_OWED: ArgosQuestion = {
  label: "Cuánto me deben",
  q: "¿Cuánto me deben y desde cuándo?",
  answer: "Te deben S/ 4.820 de 23 personas. S/ 1.150 llevan más de 60 días.",
  how: "cargos sin pagar a hoy, por la fecha del cargo. Todas las sedes.",
  consulting: "Consultando las cifras de Reportes",
  bars: [
    ["0 a 30 días", 2600, "S/ 2.600"],
    ["31 a 60 días", 1070, "S/ 1.070"],
    ["Más de 60 días", 1150, "S/ 1.150"],
  ],
}

export const ARGOS_TOP_SALES: ArgosQuestion = {
  label: "Qué se vendió más",
  q: "¿Qué se vendió más este mes?",
  answer: "Limpieza dental: S/ 3.200 en 40 atenciones, seguida de la resina simple.",
  how: "lo cobrado por servicio en octubre, sin impuestos. Todas las sedes.",
  consulting: "Consultando las cifras de Reportes",
  bars: [
    ["Limpieza dental", 3200, "S/ 3.200"],
    ["Resina simple", 2450, "S/ 2.450"],
    ["Endodoncia", 1800, "S/ 1.800"],
  ],
}

/** La de Reportes: la misma pregunta de lo que te deben, en columnas por tramo. */
export const REPORTS_OWED: ArgosQuestion = {
  ...ARGOS_OWED,
  answer: "Te deben **S/ 4.820** de 23 personas. **S/ 1.150** llevan más de 60 días.",
  consulting: "Consultando lo cobrado y los cargos sin pagar",
  how: "cargos sin pagar a hoy, por la fecha del cargo.",
  bars: [
    ["0–30 d", 2600, "2.600"],
    ["31–60 d", 1070, "1.070"],
    ["+60 d", 1150, "1.150"],
  ],
}

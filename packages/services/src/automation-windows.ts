// Módulo hoja, sin importaciones: el asesor lee esta ventana al cargarse y
// `automation.ts` llega hasta él por `workspace.ts`; aquí no hay ciclo posible.

/** Ventana del recordatorio de control: avisa de los controles que vencen en estas horas. */
export const CHECKUP_REMINDER_WINDOW_HOURS = 48

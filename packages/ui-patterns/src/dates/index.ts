/**
 * Los cuatro controles de fecha y hora de la aplicación (decisión 11 de la
 * fase 3). Ninguna pantalla usa los campos de fecha u hora del navegador, que
 * escriben distinto según el equipo:
 *
 * - «Fecha de nacimiento» (`BirthDateInput`): se escribe en el orden de la
 *   clínica, con la edad debajo. Sin edad (`PastDateInput`), para las demás
 *   fechas pasadas que uno recuerda.
 * - «Día» (`DatePickerButton`): el calendario estándar, con mes y año en lista.
 * - «Día y hora» (`DueAtField`): lo que vence, en la zona de la clínica.
 * - «Hora» (`TimeSelect`): una lista cada 15 minutos.
 */
export {
  BirthDateInput,
  type BirthDateInputProps,
  PastDateInput,
} from "./birth-date-input.js"
export { DueAtField, type DueAtFieldProps, dueParts } from "./due-at-field.js"
export {
  clockMinutes,
  clockValue,
  TimeSelect,
  type TimeSelectProps,
  timeOptions,
} from "./time-select.js"
export {
  ageText,
  clinicDateLocale,
  type DatePart,
  isIsoDate,
  likelyLocaleOf,
  readWrittenDate,
  WRITTEN_DATE_MAX_YEARS,
  type WrittenDateFormat,
  type WrittenDateProblem,
  type WrittenDateReading,
  writeDate,
  writtenDateFormat,
  writtenDateProblemText,
} from "./written-date.js"

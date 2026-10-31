import type {
  RegistrationConfig,
  RegistrationFieldKey,
  RegistrationFieldMode,
} from "@odentia/clinical"
import { FieldError } from "@odentia/ui"
import { Lock } from "lucide-react"
import { useId } from "react"
import { ChoiceButtons } from "../choice-buttons"
import { productUi } from "../../product/product-ui"

/**
 * Qué se le pide al paciente, dato por dato, con tres botones que dicen lo que
 * significan: «No preguntar» (el dato existe en su ficha, solo no se pregunta
 * al registrar), «Opcional» (se pregunta y puede dejarlo en blanco) y
 * «Obligatorio» (se pregunta, lleva asterisco y, si falta, sale «Faltan datos»;
 * nunca impide registrarlo). Una sola regla para recepción y para lo que llena
 * el paciente.
 */
interface PickerItem {
  /** Los datos que van juntos (el documento: tipo y número). */
  keys: RegistrationFieldKey[]
  label: string
  hint?: string
}

const CLINIC: PickerItem[] = [
  { keys: ["docType", "docNumber"], label: "Documento", hint: "Tipo y número" },
  { keys: ["sex"], label: "Sexo" },
  { keys: ["nationality"], label: "Nacionalidad" },
  { keys: ["birthPlace"], label: "Lugar de nacimiento" },
  { keys: ["email"], label: "Correo" },
  { keys: ["address"], label: "Dirección", hint: "Calle y número, distrito y una referencia" },
  {
    keys: ["emergencyContactName", "emergencyContactPhone"],
    label: "Contacto de emergencia",
    hint: "Nombre, teléfono y qué es del paciente",
  },
  {
    keys: ["insuranceType"],
    label: "Seguro",
    hint: "Cuál tiene, la aseguradora y el número de afiliación",
  },
]
const HEALTH: PickerItem[] = [
  { keys: ["allergies"], label: "Alergias" },
  { keys: ["conditions"], label: "Enfermedades" },
  { keys: ["medications"], label: "Medicación" },
  { keys: ["bloodGroup"], label: "Grupo sanguíneo" },
]
const PERSONAL: PickerItem[] = [
  { keys: ["personal.embarazo"], label: "Embarazo", hint: "Solo a mujeres de 12 a 55 años" },
  { keys: ["personal.cirugias"], label: "Operaciones" },
  { keys: ["personal.hospitalizaciones"], label: "Hospitalizaciones" },
  { keys: ["personal.transfusiones"], label: "Transfusiones de sangre" },
]
const DENTAL: PickerItem[] = [
  { keys: ["dental.ultimaVisita"], label: "Última visita al dentista" },
  { keys: ["dental.experienciaPrevia"], label: "Cómo le fue antes" },
  { keys: ["dental.ansiedadDental"], label: "Miedo al dentista" },
  { keys: ["dental.cepilladosAlDia"], label: "Cuántas veces se cepilla al día" },
  { keys: ["dental.hiloDental"], label: "Hilo dental" },
  { keys: ["dental.bruxismo"], label: "Aprieta o rechina los dientes" },
  {
    keys: ["dental.habitos"],
    label: "Hábitos",
    hint: "Fumar, morderse las uñas, respirar por la boca…",
  },
]
/** Lo que pregunta latidIA (issue 229): la lactancia, junto al embarazo, y los hábitos. */
const MEDICAL_PERSONAL: PickerItem[] = [
  { keys: ["medical.lactancia"], label: "Lactancia", hint: "Solo a mujeres de 12 a 55 años" },
]
const MEDICAL_HABITS: PickerItem[] = [
  { keys: ["medical.tabaco"], label: "Si fuma" },
  { keys: ["medical.alcohol"], label: "Si toma alcohol" },
]
const CENSUS: PickerItem[] = [
  { keys: ["maritalStatus"], label: "Estado civil" },
  { keys: ["educationLevel"], label: "Nivel educativo" },
  { keys: ["occupation"], label: "Ocupación" },
  { keys: ["referralSource"], label: "Cómo nos conoció" },
  { keys: ["origin"], label: "Procedencia" },
]

const THREE: ReadonlyArray<{ value: RegistrationFieldMode; label: string }> = [
  { value: "hidden", label: "No preguntar" },
  { value: "optional", label: "Opcional" },
  { value: "required", label: "Obligatorio" },
]
/** Lo censal nunca es obligatorio: no cuenta para atender. */
const TWO = THREE.slice(0, 2)

type Fields = RegistrationConfig["fields"]
/** Lo que hay que corregir de cada dato, junto a su fila. */
export type RegistrationFieldErrors = Partial<Record<RegistrationFieldKey, string>>

function Row({
  item,
  fields,
  options,
  onMode,
  disabled,
  errors,
}: {
  item: PickerItem
  fields: Fields
  options: ReadonlyArray<{ value: RegistrationFieldMode; label: string }>
  onMode: (keys: RegistrationFieldKey[], mode: RegistrationFieldMode) => void
  disabled: boolean
  errors: RegistrationFieldErrors
}) {
  const current = fields[item.keys[0] as RegistrationFieldKey]
  const labelId = useId()
  const errorId = useId()
  const error = item.keys.map((key) => errors[key]).find(Boolean)
  return (
    <div className="flex flex-col gap-1 border-b py-3 last:border-b-0">
      <div className="@container flex min-w-0 flex-col gap-2 @md:flex-row @md:items-center @md:justify-between">
        <div className="flex min-w-0 flex-col">
          <span id={labelId} className="text-sm font-medium">{item.label}</span>
          {item.hint ? <span className="text-xs text-muted-foreground">{item.hint}</span> : null}
        </div>
        <ChoiceButtons
          aria-labelledby={labelId}
          aria-describedby={error ? errorId : undefined}
          invalid={Boolean(error)}
          value={options.some((option) => option.value === current) ? current : "optional"}
          options={options}
          onChange={(mode) => onMode(item.keys, mode)}
          disabled={disabled}
          columns={options.length === 3 ? 3 : 2}
          className="@md:w-auto @md:min-w-80"
        />
      </div>
      {error ? <FieldError id={errorId}>{`${item.label}: ${error}`}</FieldError> : null}
    </div>
  )
}

function Group({
  title,
  help,
  items,
  fields,
  options,
  onMode,
  disabled,
  errors,
}: {
  title: string
  help: string
  items: PickerItem[]
  fields: Fields
  options: ReadonlyArray<{ value: RegistrationFieldMode; label: string }>
  onMode: (keys: RegistrationFieldKey[], mode: RegistrationFieldMode) => void
  disabled: boolean
  errors: RegistrationFieldErrors
}) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-col gap-0.5">
        <h3 className="text-sm font-semibold">{title}</h3>
        <p className="text-sm text-muted-foreground">{help}</p>
      </div>
      <div className="flex flex-col">
        {items.map((item) => (
          <Row
            key={item.label}
            item={item}
            fields={fields}
            options={options}
            onMode={onMode}
            disabled={disabled}
            errors={errors}
          />
        ))}
      </div>
    </div>
  )
}

export function RegistrationFieldsPicker({
  fields,
  onMode,
  disabled,
  showOrigin,
  errors = {},
}: {
  fields: Fields
  onMode: (keys: RegistrationFieldKey[], mode: RegistrationFieldMode) => void
  disabled: boolean
  /** «Procedencia» solo en clínicas de Perú. */
  showOrigin: boolean
  /** El motivo de cada dato que no se puede guardar así (del esquema o del servidor). */
  errors?: RegistrationFieldErrors
}) {
  // Lo de cada producto: «Su historia dental» en odentIA; la lactancia y los hábitos en latidIA.
  const product = productUi().product
  return (
    <div className="flex flex-col gap-7">
      <dl className="grid gap-2 rounded-2xl bg-muted/60 p-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="font-medium">Obligatorio</dt>
          <dd className="text-muted-foreground">
            El paciente no envía su registro sin responderlo. Si lo registra recepción sin ese dato,
            su página dice «Faltan datos».
          </dd>
        </div>
        <div>
          <dt className="font-medium">Opcional</dt>
          <dd className="text-muted-foreground">
            Se pregunta con «(opcional)» y puede dejarlo en blanco.
          </dd>
        </div>
        <div>
          <dt className="font-medium">No preguntar</dt>
          <dd className="text-muted-foreground">
            No sale al registrar. Se puede escribir igual en su ficha.
          </dd>
        </div>
      </dl>

      <div className="flex flex-col gap-1">
        <div className="flex flex-col gap-0.5">
          <h3 className="text-sm font-semibold">Siempre obligatorios</h3>
          <p className="text-sm text-muted-foreground">
            Hacen falta para atenderlo; no se pueden quitar.
          </p>
        </div>
        {["Nombres y apellidos", "Fecha de nacimiento", "Celular o correo"].map((label) => (
          <div
            key={label}
            className="flex items-center justify-between gap-3 border-b py-3 last:border-b-0"
          >
            <span className="text-sm font-medium">{label}</span>
            <span className="inline-flex items-center gap-1.5 rounded-full bg-muted px-3 py-1.5 text-sm text-muted-foreground">
              <Lock aria-hidden className="size-3.5" />
              Obligatorio
            </span>
          </div>
        ))}
      </div>

      <Group
        title="Datos de la persona"
        help="Lo que tu clínica necesita además para atenderlo."
        items={CLINIC}
        fields={fields}
        options={THREE}
        onMode={onMode}
        disabled={disabled}
        errors={errors}
      />
      <Group
        title="Su salud"
        help="Se la pregunta antes de su atención; quien atiende la revisa."
        items={HEALTH}
        fields={fields}
        options={THREE}
        onMode={onMode}
        disabled={disabled}
        errors={errors}
      />
      <Group
        title="Otros antecedentes"
        help="Llegan a su entrevista de salud. Nunca son obligatorios."
        items={product === "medical" ? [...PERSONAL, ...MEDICAL_PERSONAL] : PERSONAL}
        fields={fields}
        options={TWO}
        onMode={onMode}
        disabled={disabled}
        errors={errors}
      />
      {product === "dental" ? (
        <Group
          title="Su historia dental"
          help="Ayuda a preparar la primera visita."
          items={DENTAL}
          fields={fields}
          options={TWO}
          onMode={onMode}
          disabled={disabled}
          errors={errors}
        />
      ) : (
        <Group
          title="Sus hábitos"
          help="Llegan a sus antecedentes. Nunca son obligatorios."
          items={MEDICAL_HABITS}
          fields={fields}
          options={TWO}
          onMode={onMode}
          disabled={disabled}
          errors={errors}
        />
      )}
      <Group
        title="Preguntas para conocerlo"
        help="Nunca son obligatorias: no hacen falta para atenderlo."
        items={showOrigin ? CENSUS : CENSUS.filter((item) => item.keys[0] !== "origin")}
        fields={fields}
        options={TWO}
        onMode={onMode}
        disabled={disabled}
        errors={errors}
      />
    </div>
  )
}

import type {
  ClinicalProduct,
  RegistrationConfig,
  RegistrationFieldKey,
  RegistrationFieldMode,
} from "@odentia/clinical"
import { Badge, FieldError } from "@odentia/ui"
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
/** «Su salud»: lo que sale arriba de su ficha y de la atención. Lo de cada producto va en `PRODUCT_FIELDS.health`. */
const HEALTH_FIRST: PickerItem[] = [
  { keys: ["allergies"], label: "Alergias y qué le pasó" },
  {
    keys: ["conditions"],
    label: "Enfermedades",
    hint: "Se marcan de una lista: diabetes, presión alta, problema del corazón, asma, epilepsia, hepatitis, problemas de sangrado, radioterapia en cabeza o cuello… y «Otra».",
  },
]
const HEALTH_MEDICINES: PickerItem[] = [
  {
    keys: ["anticoagulants"],
    label: "Anticoagulantes o aspirina diaria",
    hint: "Warfarina, rivaroxabán, apixabán, clopidogrel. Se pregunta en «Tus medicinas», aparte.",
  },
  {
    keys: ["boneMedicines"],
    label: "Medicinas para los huesos",
    hint: "Pastillas o inyección, por osteoporosis o por un cáncer, ahora o antes.",
  },
  { keys: ["medications"], label: "Otros medicamentos de todos los días" },
  { keys: ["bloodGroup"], label: "Grupo sanguíneo" },
]
const DENTAL_HEALTH: PickerItem[] = [
  { keys: ["dental.corazon"], label: "Corazón: válvula, endocarditis o antibiótico antes del dentista" },
  { keys: ["dental.problemaAnestesia"], label: "Problemas con la anestesia o sangrado tras una extracción" },
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
    hint: "Morderse las uñas, respirar por la boca, morder lápices…",
  },
]
/**
 * La lactancia, junto al embarazo, la preguntan odentIA y latidIA (issue 229); el tabaco
 * también, con cuántos al día: es el mismo dato en los dos.
 */
const LACTATION: PickerItem = { keys: ["medical.lactancia"], label: "Lactancia", hint: "Solo a mujeres de 12 a 55 años" }
const TOBACCO: PickerItem = {
  keys: ["medical.tabaco"],
  label: "Fuma y cuántos cigarrillos al día",
  // Las mismas palabras que ve el paciente (B14).
  hint: "Nunca fumé · Fumo (menos de 10 o 10 o más) · Lo dejé.",
}
const ALCOHOL: PickerItem = { keys: ["medical.alcohol"], label: "Si toma alcohol" }
const MEDICAL_HABITS: PickerItem[] = [TOBACCO, ALCOHOL]
/**
 * Lo de cada producto en el registro: lo que suma a «Otros antecedentes» y su
 * grupo propio («Su historia dental» en odentIA; los hábitos en latidIA). vistIA
 * todavía no pregunta nada propio: sus antecedentes de la vista llegan con el examen.
 */
const PRODUCT_FIELDS: Record<
  ClinicalProduct,
  {
    health: PickerItem[]
    personal: PickerItem[]
    own: { title: string; help: string; items: PickerItem[] } | null
  }
> = {
  dental: {
    health: DENTAL_HEALTH,
    // El alcohol, también en odentIA (QA del 14 nov, C4).
    personal: [LACTATION, TOBACCO, ALCOHOL],
    own: { title: "Su historia dental", help: "Ayuda a preparar la primera visita.", items: DENTAL },
  },
  medical: {
    health: [],
    personal: [LACTATION],
    own: { title: "Sus hábitos", help: "Llegan a sus antecedentes. Nunca son obligatorios.", items: MEDICAL_HABITS },
  },
  optical: { health: [], personal: [], own: null },
}
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
  isNew,
}: {
  item: PickerItem
  isNew: boolean
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
          <span id={labelId} className="text-sm font-medium">
            {item.label}
            {/* Las que sumó la lista y nadie de la clínica vio aún: ya se preguntan, como «Opcional». */}
            {isNew ? (
              <Badge variant="secondary" className="ml-2 align-middle">
                Nueva
              </Badge>
            ) : null}
          </span>
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
  newKeys,
}: {
  title: string
  help: string
  items: PickerItem[]
  newKeys: ReadonlySet<RegistrationFieldKey>
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
            isNew={item.keys.some((key) => newKeys.has(key))}
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
  newKeys = new Set(),
}: {
  fields: Fields
  /** Las preguntas que sumó la lista y nadie de la clínica vio aún. */
  newKeys?: ReadonlySet<RegistrationFieldKey>
  onMode: (keys: RegistrationFieldKey[], mode: RegistrationFieldMode) => void
  disabled: boolean
  /** «Procedencia» solo en clínicas de Perú. */
  showOrigin: boolean
  /** El motivo de cada dato que no se puede guardar así (del esquema o del servidor). */
  errors?: RegistrationFieldErrors
}) {
  // Lo de cada producto: «Su historia dental» en odentIA; la lactancia y los hábitos en latidIA.
  const product = productUi().product
  const own = PRODUCT_FIELDS[product].own
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
        newKeys={newKeys}
        fields={fields}
        options={THREE}
        onMode={onMode}
        disabled={disabled}
        errors={errors}
      />
      <Group
        title="Su salud"
        help="Todo queda en sus Antecedentes; lo que cambia la cita sale arriba de su ficha y de la atención, y quien atiende lo revisa con él."
        // vistIA no pregunta por las dos medicinas (QA del 14 nov, C5).
        items={[...HEALTH_FIRST, ...PRODUCT_FIELDS[product].health, ...(product === "optical" ? [] : HEALTH_MEDICINES)]}
        newKeys={newKeys}
        fields={fields}
        options={THREE}
        onMode={onMode}
        disabled={disabled}
        errors={errors}
      />
      <Group
        title="Otros antecedentes"
        help="Llegan a su entrevista de salud. Nunca son obligatorios."
        items={[...PERSONAL, ...PRODUCT_FIELDS[product].personal]}
        newKeys={newKeys}
        fields={fields}
        options={TWO}
        onMode={onMode}
        disabled={disabled}
        errors={errors}
      />
      {own ? (
        <Group
          title={own.title}
          help={own.help}
          items={own.items}
          newKeys={newKeys}
          fields={fields}
          options={TWO}
          onMode={onMode}
          disabled={disabled}
          errors={errors}
        />
      ) : null}
      <Group
        title="Preguntas para conocerlo"
        help="Nunca son obligatorias: no hacen falta para atenderlo."
        items={showOrigin ? CENSUS : CENSUS.filter((item) => item.keys[0] !== "origin")}
        newKeys={newKeys}
        fields={fields}
        options={TWO}
        onMode={onMode}
        disabled={disabled}
        errors={errors}
      />
    </div>
  )
}

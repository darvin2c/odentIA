// «Tu clínica es…»: tres tamaños de ejemplo que llenan la calculadora; los números se siguen ajustando a mano.
import { WORDS } from "../lib/product"
import { CLINIC_SIZES, type ClinicSize, type ValueInput } from "../lib/value"
import "./size-picker.css"

export default function SizePicker({
  current,
  onPick,
}: {
  current: ClinicSize | null
  onPick: (input: ValueInput) => void
}) {
  return (
    <fieldset className="sizes">
      <legend>{WORDS.YourClinic} es</legend>
      <div className="sizes-row">
        {CLINIC_SIZES.map((s) => (
          <button
            key={s.id}
            type="button"
            className={s.id === current ? "size on" : "size"}
            aria-pressed={s.id === current}
            onClick={() => onPick(s.input)}
          >
            <strong>{s.label}</strong>
            <span>{s.hint}</span>
          </button>
        ))}
      </div>
      <span className="sizes-note">
        {current ? "Números de ejemplo: ajústalos a los tuyos." : "A tu medida: con tus números."}
      </span>
    </fieldset>
  )
}

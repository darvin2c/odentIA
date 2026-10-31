import { ShieldCheck } from "lucide-react"
import { useKnownStaff } from "../lib/admin-access"
import { adminUrl } from "../lib/host"

/** La entrada a la administración en «Elige tu clínica», solo para el personal; también mientras carga. */
export function StaffEntry() {
  if (!useKnownStaff()) return null
  return (
    <a href={adminUrl()} className="flex items-center gap-3 rounded-xl border bg-card p-4 hover:bg-muted">
      <ShieldCheck className="size-5" aria-hidden />
      <div>
        <p className="font-medium">Administración de odentIA</p>
        <p className="text-sm text-muted-foreground">Organizaciones clientes, cobros y soporte</p>
      </div>
    </a>
  )
}

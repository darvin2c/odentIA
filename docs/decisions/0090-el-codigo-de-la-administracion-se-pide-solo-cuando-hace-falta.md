# 0090 · El código de la administración se pide solo cuando hace falta: equipo nuevo, otro país, 30 días o cambios de la cuenta

Fecha: 2026-10-26 · Estado: aceptada · Reemplaza el plazo fijo de 48 h de la [0089](0089-el-personal-pone-su-codigo-al-abrir-la-administracion.md)

## Problema

Con la 0089 el código ya no se pedía al entrar, pero la administración lo volvía a pedir cada 48 horas en cada sesión, aunque fuera el mismo equipo de todos los días. Un plazo fijo molesta a quien trabaja siempre desde el mismo lugar y no protege más: lo que importa es que quien tiene la contraseña sea quien tiene el teléfono.

## Decisión y motivo

- **Equipo reconocido.** Al poner el código de la app, el navegador queda reconocido: guarda un token aleatorio en una cookie solo para la API (`odentia_admin_device`, ruta `/api`, `HttpOnly`, `Secure`, `SameSite=Lax`, 30 días) y la base guarda solo su hash (`admin.admin_trusted_device`). Un código de respaldo no reconoce el equipo: obliga a enrolar de nuevo.
- **El código se pide solo si se cumple una de estas cuatro reglas** (`resolveAdminVerification`):
  1. **Equipo nuevo:** el navegador no trae un token válido, por ser la primera vez, por datos borrados o por ser de otra persona, o **se cerró sesión**: cerrarla olvida el equipo (`forgetAdminDeviceOnSignOut`), para que en un equipo prestado quien entre después ponga el código. Una sesión que vence sola no lo olvida.
  2. **Otro país:** el país de la visita (la cabecera `cf-ipcountry` de Cloudflare, delante de todo acceso) no es el del último código. Ese equipo se conserva y vuelve a valer al poner el código desde allí.
  3. **30 días sin abrir la administración** en ese equipo. Cada uso renueva el plazo y la cookie.
  4. **Cambió la cuenta:** otra contraseña (se compara una huella del hash guardado) u otro factor (reinicio o nuevo enrolamiento). Revocar o reiniciar el factor retira además todos los equipos.
- **La marca de la sesión guarda el país.** Desde otro país deja de contar. La que deja un equipo reconocido dura una hora, para que sus reglas se revisen seguido.
- **La comprobación la hace el navegador, no el servidor de la administración.** La zona protegida va sin SSR (`ssr: false` en `_app`): el servidor de la administración no tiene la cookie del equipo (es de la API) y, al llamar a la API por internet, Cloudflare le pondría su propio país. Si a mitad de trabajo la API vuelve a pedir el código (`MFA_REQUIRED`), la pantalla lleva a ponerlo.
- **Señales que se dejan fuera a propósito:** el cambio de conexión dentro del mismo país (en Perú la dirección del celular y de muchas casas cambia varias veces al día), el horario y el comportamiento. Adivinar con ellas pediría el código sin razón o dejaría de pedirlo cuando hace falta.

## Alternativas descartadas

- **Plazo fijo (48 h, 0089):** pide el código aunque nada haya cambiado.
- **Pedirlo solo para acciones delicadas:** hay que decidir qué cuenta como delicado y el código interrumpe a mitad de una tarea. Se puede sumar más adelante para dos o tres acciones.
- **Riesgo por puntaje (dirección, horario, comportamiento):** difícil de hacer bien y de explicar.

## Consecuencias

- Beneficio: en su equipo de siempre, el personal pone el código casi nunca. Quien consiga la contraseña desde otro equipo o país lo necesita.
- Sacrificio: quien robe el navegador ya reconocido (con la sesión y la cookie) entra a la administración sin código hasta 30 días mientras nadie cierre sesión. Lo cortan cerrar sesión, cambiar la contraseña o reiniciar el factor.
- Sin la cabecera de Cloudflare (desarrollo, pruebas) el país es nulo y nulo con nulo cuenta como el mismo. Si algún día se entra sin pasar por Cloudflare, la regla 2 deja de distinguir países.
- Revisar si hace falta ver y olvidar los equipos reconocidos desde la administración: iría primero al lienzo.

## Referencias

`packages/services/src/admin-core.ts` (`trustAdminDevice`, `resolveAdminVerification`), `apps/api/src/lib/admin-context.ts` (guard y cookie), `apps/api/src/routes/admin-core.ts`, `packages/db/drizzle/0003_admin_trusted_device.sql`, `apps/admin/src/routes/_app.tsx` y `apps/admin/src/lib/api.ts`, las pruebas «equipo reconocido» de `admin-core.test.ts` y `admin-consumer-complaints.test.ts`, y el recorrido `e2e/admin-trusted-device.spec.ts`.

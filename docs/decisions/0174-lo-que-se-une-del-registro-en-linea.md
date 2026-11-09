# Lo que se une del registro en línea se revisa dato por dato

9 nov 2026. **Estado:** aceptada.

## Problema

Quien se registra por el código QR o el enlace de la clínica no prueba quién es (ADR 0001): si su documento o su celular ya son de alguien, no se crea ni se cambia nada y recepción decide en «¿Es la misma persona?». Hasta ahora «Es la misma persona» solo llenaba lo vacío (y elegía los apellidos): un celular o una dirección nuevos se veían y no había cómo guardarlos. Además, el aviso podía no llegar: una persona de prueba con ese documento lo escondía, un DNI guardado sin país no se reconocía (se creaba otra ficha) y un choque al guardar se perdía con «No pudimos completar el registro».

## Decisión y motivo

- **Como revisar cambios antes de aceptarlos.** Cada grupo de datos que escribió (nombres y apellidos juntos, la dirección entera, el seguro entero…) va en una fila con lo de antes y lo nuevo; se guarda solo lo marcado y lo de antes queda en una nota de su persona. Recepción decide con todo a la vista, sin rehacerlo a mano.
- **Lo administrativo viene marcado; quién es y por dónde se le escribe, no.** Nombres, nacimiento, sexo, celular y correo vienen sin marcar: con el documento de otra persona, marcarlos sin mirar le daría a quien se registró las citas, el enlace y las recetas de esa persona, y el nacimiento y el sexo cambian dosis y quién firma por un menor. Avisa y deja hacer: se marcan si se comprobó que es ella (decidido por el usuario el 9 nov, tras la mesa).
- **Nunca desde ahí:** el documento (es lo que identifica) y una fecha que la vuelva menor (necesita a su representante). La salud declarada no pisa lo guardado: si ya había, sus alergias se suman sin confirmar para que la receta avise.
- **Lo que se vio es lo que se guarda.** La decisión lleva la huella de lo que recepción tenía a la vista; si la persona o lo escrito cambiaron, se rechaza.
- **El aviso siempre llega.** Una persona de prueba no es nadie y suelta su documento; un documento sin país emisor es el mismo; un choque al guardar también queda para recepción. Lo público responde igual en todos los casos.

## Alternativas descartadas

- **Todo marcado.** Un clic apurado reemplaza la identidad de una ficha real con lo que escribió un desconocido.
- **Llenar solo lo vacío.** Seguro, pero lo nuevo de verdad (otro celular, otra dirección) no tenía camino.
- **Mandar a «Editar datos» con lo nuevo escrito.** Más pasos y lo de antes no quedaba dicho.

## Consecuencias

Recepción decide en una pantalla y la ficha guarda de dónde vino cada cambio. Lo que cambia la identidad cuesta un clic más. Pendiente: el consentimiento y los permisos de mensajes de quien se registró no se guardan al resolver; el responsable de un menor no se resuelve aquí; lo demás de su salud (enfermedades, medicación) queda en una nota de su persona.

## Referencias

`packages/services/src/registration-hold.ts`, `resolveRegistrationHold` y `registerPatient` en `patient-registration.ts`, `releaseTestDocument` y `findRealPersonByDocument` en `people.ts`, `packages/clinic-app/src/components/home/registration-hold-drawer.tsx`. Sigue a ADR 0001 y 0130.

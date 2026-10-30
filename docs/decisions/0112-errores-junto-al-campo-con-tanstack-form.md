# 0112 · Formularios con TanStack Form y cada error junto a su campo

- Fecha: 2026-10-30.
- Estado: aceptada.

## Problema

Quien guardaba un formulario casi nunca veía qué dato corregir. Recibía un aviso genérico («No se guardaron los cambios. Revisa los campos…»), un toast que se iba solo o un aviso arriba del cajón, fuera de la vista en formularios largos. Pasaba por cuatro causas encadenadas:

- La API respondía solo el primer mensaje del esquema, sin el campo, y en inglés si el esquema no traía mensaje propio.
- Los servicios calculaban el error de cada campo y tiraban todos menos el primero.
- El cliente cambiaba el mensaje del servidor por uno genérico.
- Las pantallas, unas 190 con `useState` y 11 con TanStack Form, conectaban `Field` cada una a su manera, a veces sin el error de un campo que sí se validaba. Esto último bloqueaba el envío sin decir nada.

## Decisión y motivo

- **La API dice el campo.** Todo error lleva `error.fields`: el nombre del dato en el cuerpo de la petición (`items[0].price`) → lo que se dice junto a él. `validationError` lo arma con todos los issues del esquema y `ServiceError` lo lleva (`fields`, `invalidField`, `fieldsError`). `message` sigue diciendo el primero.
- **Los mensajes sin texto propio van en español.** Las reglas de Zod sin mensaje propio hablan como la interfaz (`zodMessages` de `@odentia/clinical`, instalado con `configureZodMessages()` en la API y en cada app).
- **Un solo formulario en la interfaz: `useAppForm`** (TanStack Form con `createFormHook`, en `ui-patterns`). Sus campos (`field.TextField`, `field.Control`…) unen la etiqueta, la ayuda y el error al control: `data-invalid`, `aria-invalid`, `aria-describedby` y el `FieldError` con su id. El error se ve al salir del campo o al enviar.
- **El rechazo se reparte solo.** `useFormSurface`/`useFormSubmit` envían el formulario y, si el servidor lo rechaza, ponen cada dato señalado en su campo, lo que no tiene campo junto a los botones y el foco en el primer campo marcado. `onSubmit` solo lanza el error, sin toast.
- **Lo que dijo el envío sigue a la vista hasta corregirlo.** TanStack Form borra los errores de envío en cualquier validación que no sea de envío, como salir de un campo: el aviso desaparecía con el dato aún mal y movía «Guardar» bajo el puntero. Los errores de campo del último envío (servidor o validación) van a `errorMap.onServer`, que se quita al cambiar ese campo o al reenviar; el general, mientras no cambie ningún valor (`setSubmitErrors`).
- **Solo se dicen los motivos de la API.** El mensaje y los campos se leen de los estados con que la API da un motivo (400, 403, 404, 409, 413, 429). Otro estado, como un 422 de un proxy, o un 5xx, se dice con palabras fijas: su cuerpo puede traer detalles internos.
- **Lo que no es de ningún campo va junto a los botones.** Sin permiso, un conflicto o «no sabemos si se guardó» se dicen en el pie del formulario, que siempre está a la vista. El formulario no usa la validación del navegador (`noValidate`): un solo sistema, en el idioma de la interfaz.
- **En el acceso, un mensaje neutro.** Credenciales, recuperar contraseña y correo ya registrado no se dicen por campo, porque revelarían qué cuentas existen ([OWASP](https://cheatsheetseries.owasp.org/cheatsheets/Authentication_Cheat_Sheet.html#authentication-and-error-messages)). Lo mismo vale para lo público que verifica identidad. El formato de lo escrito y lo que se pide dentro de la sesión sí van por campo.

## Alternativas descartadas

- **Seguir con `useState` y arreglar cada pantalla.** Cada una repetía el cableado de `Field` y lo olvidaba distinto; el error del servidor seguía sin camino hacia el campo.
- **Mapear el texto del mensaje a un campo en el cliente** (buscar «lote» o «correo» en la frase). Se rompe al cambiar una palabra y no sirve para los mensajes de Zod.
- **`errorMap` propio por pantalla en vez de `setErrorMap` de TanStack.** Duplica el estado de error y no se limpia al corregir el campo.

## Consecuencias

- Un error nuevo de un dato se lanza con su campo (`invalidField`), con el nombre que tiene en el cuerpo. Si la pantalla lo llama distinto, lo traduce con `fieldMap`.
- Un esquema del cliente que valida un dato sin campo en pantalla vuelve a bloquear en silencio: cada clave del esquema debe tener su campo o un valor que siempre pase.
- Si un formulario necesita una regla que no cabe en un campo (comparar dos), el error se asigna al campo que hay que cambiar.

## Referencias

- `apps/api/src/lib/error.ts`, `apps/api/src/routes/helpers.ts` (`validationError`).
- `packages/services/src/errors.ts` (`ServiceError.fields`, `invalidField`, `fieldsError`, `issueFields`).
- `packages/clinical/src/zod-messages.ts`.
- `packages/ui-patterns/src/form/` (`app-form.tsx`, `fields.tsx`, `field-control.tsx`, `server-errors.ts`, `submit-error.ts`; story `ErroresPorCampo`).

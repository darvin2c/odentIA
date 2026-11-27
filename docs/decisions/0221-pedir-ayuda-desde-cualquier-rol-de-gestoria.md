# 0221 · Pedir ayuda desde cualquier rol de gestorIA

Fecha: 2026-11-26 · Estado: aceptada · Extiende el acuerdo de la [0211](0211-el-acuerdo-de-las-apps.md) y la [0212](0212-gestoria-usa-el-acuerdo.md)

## Problema

En gestorIA solo el Dueño podía escribirle al equipo de gestorIA, dentro de «Plan y pagos». La entrega 7 del lienzo «gestorIA como odentIA» (decisión 6) abre «Pedir ayuda» a todo el equipo, desde cualquier pantalla, con la respuesta de vuelta en la Ayuda. Dos cosas lo impedían: el estado de la cuenta devolvía los casos de soporte de toda la tienda sin decir quién los abrió (Ventas habría visto las preguntas del Dueño sobre el plan y sus cobros, que su rol no ve), y la administración no sabía desde qué pantalla ni con qué rol se preguntaba, cuando en las clínicas sí lo sabe.

## Decisión y motivo

- **Pide ayuda todo el equipo (`ayuda.pedir`: Dueño, Administrador y Ventas).** Soporte de gestorIA, que solo mira, no le pregunta a su propio equipo. Lo del cobro sigue siendo del Dueño: el formulario de «Plan y pagos» exige `plan`, y «Pedir ayuda» de la Ayuda siempre manda una pregunta (`pregunta`).
- **`soporte.pedido` suma la pantalla y el rol, opcionales.** La administración los guarda en el caso, en las mismas columnas que llena la Ayuda de una clínica: la Bandeja dice «Pantalla: /pedidos?pedido=… · Rol: Ventas».
- **Cada caso del estado dice quién lo abrió (`userId`, opcional).** La Ayuda le muestra a cada persona solo sus preguntas y sus respuestas; las que aún no vuelven entre los casos se leen de la bandeja de salida, también solo las suyas. «Plan y pagos» del Dueño sigue con todos los casos de la tienda.
- **Los campos nuevos son opcionales en los dos sentidos.** gestorIA y la administración se despliegan por separado: cada lado acepta al otro sin ellos. Un caso sin `userId` (de una administración anterior) solo se ve en «Plan y pagos».

## Alternativas descartadas

- *Mostrar a todo el equipo todos los casos de la tienda.* Expone a Ventas lo del plan y lo que preguntó otra persona.
- *Responder en «Soporte de tu cuenta» (`/cuenta/soporte`).* En el dominio de una app esa pantalla muestra solo los casos de la cuenta, sin los de la tienda (ADR 0218); abrirla a los de la tienda mezclaría la cuenta con cada app, y la persona tendría que salir de su tienda para leer la respuesta.
- *Escribir la pantalla y el rol dentro del detalle de la pregunta.* La administración ya tiene dónde guardarlos y los muestra igual para las clínicas; en el texto no se podrían leer ni contar.

## Consecuencias

- Cualquier persona del equipo llega a la Bandeja de la administración con su contexto, y ve la respuesta en la Ayuda, a lo más unos 10 minutos después (lo que tarda gestorIA en volver a preguntar el estado). Abrir la Ayuda no espera a la administración.
- El estado devuelve hasta 20 casos por cuenta: con todo el equipo preguntando, los más viejos dejan de verse antes. Revisar si una tienda llega a ese número.

## Referencias

- `shared/packages/contract/src/messages.ts` (`supportEvent`, `accountState.support`), `packages/services/src/app-contract.ts` (`applySupport`, `answerAppState`).
- `gestoria/apps/api/src/permisos.ts` (`ayuda.pedir`), `acuerdo.ts` (`askForHelp`, `helpView`), `ayuda.ts` (la guía); `gestoria/apps/web/src/ayuda.tsx` y `pedir-ayuda.tsx`.

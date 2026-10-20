/**
 * Dominio de formularios: shell compartido (`FormSurface`), contenedores
 * (`FormDrawer` modal y `FormPanel` lateral), acciones (`SubmitButton`),
 * asistentes (`WizardSteps`) y mensajes de error de campo.
 *
 * El barrel raíz reexporta esta carpeta completa; `form-surface` es interno
 * (lo consumen los dos contenedores, no las páginas).
 */
export { fieldErrorMessages } from "./field-errors.js"
export { FormDrawer, type FormDrawerProps } from "./form-drawer.js"
export { FormPanel, type FormPanelProps } from "./form-panel.js"
export type { FormSecondaryAction } from "./form-surface.js"
export { SubmitButton, type SubmitButtonProps } from "./submit-button.js"
export { type WizardStep, WizardSteps, type WizardStepsProps } from "./wizard-steps.js"

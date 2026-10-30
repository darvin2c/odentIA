/**
 * Dominio de formularios: el formulario de la interfaz (`useAppForm`, TanStack
 * Form con los campos unidos a su etiqueta, ayuda y error), el shell
 * compartido (`FormSurface`), los contenedores (`FormDrawer` modal y
 * `FormPanel` lateral), acciones (`SubmitButton`), asistentes (`WizardSteps`) y
 * cómo se lee un rechazo del servidor (`submitErrorOf`).
 *
 * El barrel raíz reexporta esta carpeta completa; `form-surface` es interno
 * (lo consumen los dos contenedores, no las páginas).
 */
export {
  applySubmitError,
  extendForm,
  type FormSurfaceBinding,
  focusFirstInvalid,
  type ServerFieldMap,
  type SubmitOptions,
  submitForm,
  useAppForm,
  useFormSubmit,
  useFormSubmitError,
  useFormSurface,
  useTypedAppFormContext,
  withFieldGroup,
  withForm,
} from "./app-form.js"
export {
  type FieldControl,
  FormChoiceField,
  FormField,
  FormFieldGroup,
  useFieldControl,
} from "./field-control.js"
export { fieldErrorMessages } from "./field-errors.js"
export {
  type CheckboxFieldProps,
  INCOMPLETE_PHONE,
  type PasswordFieldProps,
  type PhoneFieldProps,
  type RadioGroupFieldProps,
  type SelectFieldProps,
  type SelectOption,
  type TextareaFieldProps,
  type TextFieldProps,
} from "./fields.js"
export { useFieldContext, useFormContext } from "./form-context.js"
export { FormDrawer, type FormDrawerProps } from "./form-drawer.js"
export { FormPanel, type FormPanelProps } from "./form-panel.js"
export type { FormSecondaryAction } from "./form-surface.js"
export { clearSubmitErrors, type SubmitErrors, setSubmitErrors } from "./server-errors.js"
export { SubmitButton, type SubmitButtonProps } from "./submit-button.js"
export {
  isUnconfirmedSubmit,
  SUBMIT_ERROR_WORDS,
  type SubmitError,
  submitErrorMessage,
  submitErrorOf,
} from "./submit-error.js"
export { type WizardStep, WizardSteps, type WizardStepsProps } from "./wizard-steps.js"

import { common } from "./common.js";
import {
 Button,
 Drawer,
 DrawerContent,
 DrawerDescription,
 DrawerFooter,
 DrawerHeader,
 DrawerTitle,
 ScrollArea,
 Skeleton,
 Spinner,
 useIsMobile,
} from "@odentia/ui";
import { SubmitButton } from "./submit-button.js";

export interface FormDrawerProps {
 open: boolean;
 onClose: () => void;
 title: string;
 description?: string;
 children: React.ReactNode;
 onSubmit: (event: React.FormEvent) => void;
 isDirty?: boolean;
 isSubmitting?: boolean;
 isLoading?: boolean;
 error?: string | null;
 fieldErrors?: Record<string, string>;
  submitLabel?: string;
  cancelLabel?: string;
  submitDisabled?: boolean;
  /** Layout extra del panel (p. ej. ancho mayor para formularios extensos). */
  className?: string;
}

/**
 * Drawer de formulario: replica patrón Sheet validado sin diseño extra.
 * Usa tokens estándar (popover/card) y layout adaptativo h-full + wrapper flex-1.
 */
export function FormDrawer({
 open,
 onClose,
 title,
 description,
 children,
 onSubmit,
 isDirty = false,
 isSubmitting = false,
 isLoading = false,
 error,
 submitLabel = common.actions.save,
  cancelLabel = common.actions.cancel,
  submitDisabled = false,
  className,
}: FormDrawerProps) {
 const isMobile = useIsMobile();

 function handleClose() {
 if (isSubmitting) return;
 if (isDirty && !window.confirm(common.confirm.unsavedMessage)) return;
 onClose();
 }

 return (<Drawer
 open={open}
 swipeDirection={isMobile ? "down" : "right"}
 showSwipeHandle={isMobile}
 onOpenChange={(nextOpen) => {
 if (!nextOpen) handleClose();
 }}
 >
      <DrawerContent className={className}>
 <form onSubmit={onSubmit} className="flex h-full flex-col overflow-hidden">
 <div className="flex justify-center pt-3 md:hidden" aria-hidden>
 <span className="h-1.5 w-10 rounded-full bg-border" />
 </div>
 <DrawerHeader className="gap-1 border-b border-border px-6 py-4 pb-4 text-left group-data-[swipe-axis=y]/drawer-popup:text-left">
 <DrawerTitle>{title}</DrawerTitle>
 {description ? <DrawerDescription>{description}</DrawerDescription> : null}
 </DrawerHeader>

 <div className="flex-1 overflow-hidden">
 <ScrollArea className="h-full">
 <div className="px-6 py-4">
 {isLoading ? (<div className="space-y-3">
 <Skeleton className="h-9 w-full" />
 <Skeleton className="h-9 w-full" />
 <Skeleton className="h-20 w-full" />
 </div>
 ) : (<>
 {error ? (<div
 className="mb-4 rounded-md border border-danger/20 bg-danger-soft px-3 py-2 text-sm text-danger"
 role="alert"
 >
 {error}
 </div>
 ) : null}
 {children}
 </>
 )}
 </div>
 </ScrollArea>
 </div>

 <DrawerFooter className="flex-row items-center justify-end gap-2 border-t border-border bg-surface px-6 py-4 pt-4">
 <Button type="button" variant="secondary" onClick={handleClose} disabled={isSubmitting}>
 {cancelLabel}
 </Button>
        <SubmitButton
          type="submit"
          variant="default"
          pending={isSubmitting}
          disabled={isLoading || submitDisabled}
        >
          {submitLabel}
        </SubmitButton>
 </DrawerFooter>
 </form>
 </DrawerContent>
 </Drawer>
 );
}

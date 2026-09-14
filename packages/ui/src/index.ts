// Barrel público de @odentia/ui.
// Los componentes se instalan SOLO vía `shadcn add` (ver components.json); este
// archivo se mantiene a mano: cada `shadcn add` que se quiera consumir vía
// barrel añade aquí una línea. Subpath exports ("./components/*", "./lib/*",
// "./hooks/*") coexisten para el enrutado del CLI y consumidores directos.

export { cn } from "./lib/utils.js";
export { useIsMobile } from "./hooks/use-mobile.js";

export { Button } from "./components/button.js";
export { Spinner } from "./components/spinner.js";
export { Skeleton } from "./components/skeleton.js";
export {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "./components/card.js";
export {
  Attachment,
  AttachmentAction,
  AttachmentActions,
  AttachmentContent,
  AttachmentDescription,
  AttachmentGroup,
  AttachmentMedia,
  AttachmentTitle,
  AttachmentTrigger,
} from "./components/attachment.js";
export {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "./components/empty.js";
export {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerFooter,
  DrawerHeader,
  DrawerTitle,
} from "./components/drawer.js";
export { Sheet, SheetContent, SheetTrigger } from "./components/sheet.js";
export {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "./components/alert-dialog.js";
export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./components/dropdown-menu.js";
export { Popover, PopoverContent, PopoverTrigger } from "./components/popover.js";
export { Input } from "./components/input.js";
export { Label } from "./components/label.js";
export {
  Field,
  FieldContent,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSeparator,
  FieldSet,
  FieldTitle,
} from "./components/field.js";
export { Badge, badgeVariants } from "./components/badge.js";
export { Toaster } from "./components/sonner.js";
export { toast } from "sonner";
export { ScrollArea } from "./components/scroll-area.js";
export { Separator } from "./components/separator.js";
export { Slider } from "./components/slider.js";
export {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "./components/table.js";

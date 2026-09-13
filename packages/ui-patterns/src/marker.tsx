import type { ComponentProps } from "react";

export type MarkerProps = ComponentProps<"span">;
export function Marker(props: MarkerProps) {
  return <span {...props} />;
}

export type MarkerContentProps = ComponentProps<"span">;
export function MarkerContent(props: MarkerContentProps) {
  return <span {...props} />;
}

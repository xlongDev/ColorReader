import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class lists with last-writer-wins semantics. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

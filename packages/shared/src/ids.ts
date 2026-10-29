import { randomUUID } from "node:crypto";

export function id(prefix = ""): string {
  const value = randomUUID();
  return prefix ? `${prefix}_${value}` : value;
}

/** Display identity is separate from LoFi's immutable, first-device account name. */
export const LOFI_CLIENT_NAME = "LoFi QSO Ferry";

export function lofiAccountEmail(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const email = value.trim();
  if (
    email.length > 254 ||
    !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ||
    [...email].some(
      (character) =>
        character.charCodeAt(0) <= 0x1f || character.charCodeAt(0) === 0x7f,
    )
  )
    return undefined;
  return email;
}

export function lofiAccountLabel(value: unknown): string {
  return lofiAccountEmail(value) ?? "Email unavailable";
}

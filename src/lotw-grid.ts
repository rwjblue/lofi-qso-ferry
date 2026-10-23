/** Single-grid LoTW profile: preserve source precision in the signed station. */
export function normalizeLotwStationGrid(input: string): string {
  // Validate ASCII before case normalization; never truncate or invent precision.
  if (
    ![4, 6, 8].includes(input.length) ||
    !/^[A-Ra-r]{2}[0-9]{2}(?:[A-Xa-x]{2}(?:[0-9]{2})?)?$/.test(input)
  )
    throw new Error("Unsupported station grid");
  return input.toUpperCase();
}

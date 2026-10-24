/** Historical region compatibility only; outbound station precision is unchanged. */
export function historicalGridsCompatible(
  source: string | undefined,
  remote: string | undefined,
): boolean {
  const valid = (value: string | undefined): value is string =>
    typeof value === "string" &&
    [2, 4, 6, 8].includes(value.length) &&
    /^[A-Ra-r]{2}(?:[0-9]{2}(?:[A-Xa-x]{2}(?:[0-9]{2})?)?)?$/.test(value);
  if (!valid(source) || !valid(remote)) return false;
  const local = source.toUpperCase();
  const observed = remote.toUpperCase();
  return local.startsWith(observed) || observed.startsWith(local);
}

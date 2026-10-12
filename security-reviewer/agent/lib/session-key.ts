// Hosted v2 stores continuation keys as `cont:<key>`; local serve and evals use the bare key.
export function prSessionKey(continuationKey: string | null | undefined): string {
  const key = continuationKey ?? "";
  return key.startsWith("cont:") ? key.slice("cont:".length) : key;
}

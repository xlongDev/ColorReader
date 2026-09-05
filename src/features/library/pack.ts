/** Extensions the importer and exporter both understand. */
export const PACK_EXTENSIONS = ["ctz", "ctzx"] as const;

export const ENCRYPTED_EXTENSION = ".ctzx";

function isEncryptedPack(path: string): boolean {
  return path.toLowerCase().endsWith(ENCRYPTED_EXTENSION);
}

/** `true` when the batch contains at least one encrypted pack. */
export function batchNeedsPassword(paths: string[]): boolean {
  return paths.some(isEncryptedPack);
}

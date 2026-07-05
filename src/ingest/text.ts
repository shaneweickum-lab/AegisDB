export const MAX_TEXT_FILE_BYTES = 10 * 1024 * 1024; // 10 MiB

export class FileTooLargeError extends Error {}

export function extractPlainText(fileBytes: Uint8Array, maxBytes: number = MAX_TEXT_FILE_BYTES): string {
  if (fileBytes.length > maxBytes) {
    throw new FileTooLargeError(`file exceeds the ${maxBytes}-byte limit`);
  }
  return Buffer.from(fileBytes).toString('utf8');
}

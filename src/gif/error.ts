/** All GIF codec errors share this prefix. */
export function gifError(message: string): Error {
  return new Error(`GIF: ${message}`);
}

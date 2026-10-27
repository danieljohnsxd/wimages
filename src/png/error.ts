/** Codec errors share one `PNG: ` prefix (still and animated). */

export function pngError(message: string): Error {
  return new Error(`PNG: ${message}`);
}

export function pngRangeError(message: string): RangeError {
  return new RangeError(`PNG: ${message}`);
}

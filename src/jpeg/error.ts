/** Every JPEG throw is prefixed `JPEG: `. RangeError is for bad options. */

export function jpegError(message: string): Error {
  return new Error(`JPEG: ${message}`);
}

export function jpegRangeError(message: string): RangeError {
  return new RangeError(`JPEG: ${message}`);
}

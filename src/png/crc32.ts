const POLY = 0xedb88320;
const CRC32_TABLE = new Uint32Array(256);

for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) !== 0 ? POLY ^ (c >>> 1) : c >>> 1;
  }
  CRC32_TABLE[n] = c >>> 0;
}

/** PNG CRC-32 (ISO 3309): poly 0xEDB88320, init/final XOR 0xFFFFFFFF. */
export function crc32(data: Uint8Array, start = 0, end = data.length): number {
  let crc = 0xffffffff;
  for (let i = start; i < end; i++) {
    const byte = data[i];
    if (byte === undefined) {
      break;
    }
    crc = (CRC32_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

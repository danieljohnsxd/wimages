import assert from "node:assert/strict";
import { test } from "node:test";
import { createPixelBuffer, decodeJpeg, encodeJpeg, transcodeJpeg } from "../dist/index.js";
import type { PixelBuffer } from "../dist/index.js";
import { ByteWriter } from "../src/jpeg/bits.ts";
import { buildExifOrientationPayload, parseExifOrientation } from "../src/jpeg/exif.ts";
import { writeApp14, writeDqt, writeMarker, writeSof } from "../src/jpeg/markers.ts";
import { encodeSequentialScans, type ComponentCoeffs } from "../src/jpeg/scan.ts";
import { STD_CHR_QUANT, STD_LUM_QUANT } from "../src/jpeg/tables.ts";

/** Same libjpeg-turbo fixtures as jpeg_decode_test.ts (JPEG bytes only). */
const RESTART_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAdACUDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/90ABAAD/9oADAMBAAIRAxEAPwDibCw6cV0lhYdOKpWAl4+RPyNaq6xDZ/LhJZR/Ag6H3Pbp9favQxGLwU3aKf3HsTwEKEOeq0l5m5YWHTitAX1tbqVgxNLjjbyoPuf8P0rlRqd9fMQ+1IieI1zjHv69K2LAS8fIn5GvGrPALWbf3HzeLx1SV4YWNvN7/Jf5/caqzX0/zmeRPRYyVA/KirdsJfL+4n5GivPeKy5PZ/ceC8FipO7k7+rP/9DkftdxegIq+TF3VTyeO57960rCw6cVmWDScfP/AOOiuksGk4+f/wAdFehiMywEFaMJfcv8z0KmCrYifPVldmnYWHTiujsrJUXc2FUDJJ6AViG7ls7F7hSGZAMAgYyTj+tV49Rvb1gZ5yVzkIFAUfh+NeDUxmDq3fLK3ov8zy8wlTwDUGryavbp951z6lbwYSCL7Rj7zBsAfTjmism2aTy/v/8AjoorheKyxbwl+H/yR8zPF5hKTcZpLskv1TZ//9k=";
const PROGRESSIVE_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wgARCAAdACUDASIAAhEBAxEB/8QAGAABAQEBAQAAAAAAAAAAAAAABAUAAwb/xAAWAQEBAQAAAAAAAAAAAAAAAAAEBQP/2gAMAwEAAhADEAAAAYlLgtDHIlMFNVu2ODyCS0qt1VEXMBa+JsJn/8QAGhABAQEBAQEBAAAAAAAAAAAAAgARARITA//aAAgBAQABBQICAgL2Ta+w2+3BfRuGx3PScBAQF9DyGw29dA5+jcdz/8QAHBEAAgIDAQEAAAAAAAAAAAAAAQMAAgQRIUET/9oACAEDAQE/ASgUG7Rr7HihPi0+yybsO7GZBqjnsLcgnhn/xAAeEQABAwQDAAAAAAAAAAAAAAADAAECBBMxQVGB8P/aAAgBAgEBPwEhQvhTsbV2nRKkDYZ1IwZadXabh/dr/8QAHRAAAQQCAwAAAAAAAAAAAAAAAQAQIVESIDFhgf/aAAgBAQAGPwJ4krk+NZXVPQ0gZPkpLf/EAB4QAAICAgMBAQAAAAAAAAAAAAABESFRYRAxoUGB/9oACAEBAAE/Ief4kfm6Ffi1Q1IVKsCJ9wsBqRgI6iWpc+hKXSHV3HI+Xg+XhMpbQw+eIob6eH//2gAMAwEAAgADAAAAECAsjEAP/8QAIBEBAAIABQUAAAAAAAAAAAAAAQARITFBYZFRcYHB0f/aAAgBAwEBPxC/4G8uKm7n4PvEWWq+7MU5iIy0XWnMcIh0A9iz/8QAHBEBAAICAwEAAAAAAAAAAAAAAQCRESExcdGh/9oACAECAQE/EF8BqI7bUReGoHikezIujo9iPPyj/8QAIxABAAICAQMEAwAAAAAAAAAAAQAhETFBUWHBcYGx0ZGh4f/aAAgBAQABPxDXU11NdQUw4a2D3fr9Sx9KiD8Q1+NmgH49Pd4169oMGbayYx366hr8bD9WzFOsUtrl55muprqVoAyroJia7RgHpVyp4pU8UXIBMCGMrjzBy7lkIB7e8/kU/9k=";
const GRAYPROGRESSIVE_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/wgALCAAdACUBAREA/8QAGAAAAwEBAAAAAAAAAAAAAAAABAUGAQP/2gAIAQEAAAABSMmRGzpemMJAlkx7RjI7mZ//xAAaEAEBAQEBAQEAAAAAAAAAAAACABEBEhMD/9oACAEBAAEFAgICAvZNr7Db7cF9G4bHc9JwEBAX0PIbDb10Dn6Nx3P/xAAdEAABBAIDAAAAAAAAAAAAAAABABAhURIgMWGB/9oACAEBAAY/AniSuT41ldU9DSBk+Skt/8QAHhAAAgICAwEBAAAAAAAAAAAAAAERIVFhEDGhQYH/2gAIAQEAAT8h5/iR+boV+LVDUhUqwIn3CwGpGAjqJalz6EpdIdXccj5eD5eEyltDD54ihvp4f//aAAgBAQAAABAMBY//xAAjEAEAAgIBAwQDAAAAAAAAAAABACERMUFRYcFxgbHRkaHh/9oACAEBAAE/ENdTXU11BTDhrYPd+v1LH0qIPxDX42aAfj093jXr2gwZtrJjHfrqGvxsP1bMU6xS2uXnma6mupWgDKugmJrtGAelXKnilTxRcgEwIYyuPMHLuWQgHt7z+RT/2Q==";
const PROGRESSIVE422_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wgARCAAdACUDASEAAhEBAxEB/8QAGQAAAgMBAAAAAAAAAAAAAAAABAUAAQYD/8QAGQEAAgMBAAAAAAAAAAAAAAAABAUBAwYC/9oADAMBAAIQAxAAAAFIyMsZELubnCHOll6+zKM8wgUZAnQsGTFdHaDrcYyI0J3MNYZKVX//xAAaEAEBAQEBAQEAAAAAAAAAAAACABEBEhMD/9oACAEBAAEFAgICAvZNr7Db7cF9G4bHc9JwEBAX0PIbDb10Dn6Nx3P/xAAdEQACAgIDAQAAAAAAAAAAAAABAgADERIEBRMx/9oACAEDAQE/ARXL3WhMmG25jnYy0JSuzSxTa+zTwEudrn2MCR+eqthVzBUs7E4IrHyeSz//xAAfEQABBAEFAQAAAAAAAAAAAAAAAQIDBBESFDFRsVL/2gAIAQIBAT8BliHV9Sm3b0PuTuXhB9yVqYwgt6bpB0GlMEsRsyW5P9eCWZudXgtyf68P/8QAHRAAAQQCAwAAAAAAAAAAAAAAAQAQIVESIDFhgf/aAAgBAQAGPwJ4krk+NZXVPQ0gZPkpLf/EAB4QAAICAgMBAQAAAAAAAAAAAAABESFRYRAxoUGB/9oACAEBAAE/Ief4kfm6Ffi1Q1IVKsCJ9wsBqRgI6iWpc+hKXSHV3HI+Xg+XhMpbQw+eIob6eH//2gAMAwEAAgADAAAAECDJASQ8IP/EACERAQACAgAGAwAAAAAAAAAAAAEAESFRMUFhcaHwkcHR/9oACAEDAQE/EJ80TwNv5t+6jxBelD4llOxtiJsvg0e9eMJIsejR7xghbGFQc7q/E1IuJIt65cdsQ0T/xAAeEQACAgICAwAAAAAAAAAAAAAAARHRIZFhcYHB8f/aAAgBAgEBPxAHRJDViBAFqdkYanZK9TsXAOETPLceD4VBtN8uqEmlD//EACMQAQACAgEDBAMAAAAAAAAAAAEAIRExQVFhwXGBsdGRoeH/2gAIAQEAAT8Q11NdTXUFMOGtg936/UsfSog/ENfjZoB+PT3eNevaDBm2smMd+uoa/Gw/VsxTrFLa5eeZrqa6laAMq6CYmu0YB6VcqeKVPFFyATAhjK48wcu5ZCAe3vP5FP/Z";
const PROGRESSIVERESTART_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwgHBgoICAgLCgoLDhgQDg0NDh0VFhEYIx8lJCIfIiEmKzcvJik0KSEiMEExNDk7Pj4+JS5ESUM8SDc9Pjv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wgARCAAdACUDASIAAhEBAxEB/8QAFwABAQEBAAAAAAAAAAAAAAAABAUAA//EABYBAQEBAAAAAAAAAAAAAAAAAAQFA//dAAQAA//aAAwDAQACEAMQAAABiUuC0MciUwU1W7Y4P//QkJLSQhVEXMBa+JsJn//EABoQAQEBAQEBAQAAAAAAAAAAAAIAEQESEwP/3QAEAAX/2gAIAQEAAQUCAgIC9k2vt//QG324L6Nw2O5//9H0nAQEBfQ8v//SGw29dA5+jcdz/8QAHBEAAgIDAQEAAAAAAAAAAAAAAQMAAgQRIUET/90ABAAD/9oACAEDAQE/ASgUG7Rr7HihPi0+z//Qsm7DuxmQao57C3IJ4Z//xAAeEQABAwQDAAAAAAAAAAAAAAADAAECBBMxQVGB8P/aAAgBAgEBPwEhQvhTsbV2nX//0CVIGwzqRgy06u03D+7X/8QAHRAAAgICAwEAAAAAAAAAAAAAAAEQIRJRIDFhgf/dAAQABf/aAAgBAQAGPwKatnb+H//QNs81P//R0uFLI//SjItx/8QAHhAAAgICAwEBAAAAAAAAAAAAAAERIVFhEDGhQYH/2gAIAQEAAT8h5/iR+boV+LVD/9DUhUqwIn3CwGpGAj//0eolqXPoSl0h1dxyf//SfLwfLwmUtoYfPEUN9PD/3QAEAAP/2gAMAwEAAgADAAAAECAsv//QMQA//8QAIBEBAAIABQUAAAAAAAAAAAAAAQARITFBYZFRcYHB0f/aAAgBAwEBPxC/4G8uKm7n4PvEWWq+7P/QxTmIjLRdacxwiHQD2LP/xAAcEQEAAgIDAQAAAAAAAAAAAAABAJERITFx0aH/2gAIAQIBAT8QXwGojttRF4an/9APFI9mRdHR7EeflH//xAAjEAEAAgIBAwQDAAAAAAAAAAABACERMUFRYcFxgbHRkaHh/90ABAAF/9oACAEBAAE/ENdTXU11BTDhrYPd+v1LH0qIPxP/0DX42aAfj093jXr2gwZtrJjHfrqGvxsP1bP/0cU6xS2uXnma6mupWgDKugmJrtGAelXP/9Kp4pU8UXIBMCGMrjzBy7lkIB7e8/kU/9k=";
const H1V2_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAoHBwYHCAgICAoOCwoKCw4NDQ4QGB8jGBEWFR0rJiEiHyIkJSEpNCkmLzc5NDFBMCIlPj4+O0NJRC43SDw+PTv/2wBDAQoLCw4NDhwQEBw7KCIoOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozv/wAARCAAlAB0DARIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDibCw6cV0lhYdOK9nC4o6MNApCw/epx/AP51q6wv2OEbeJZUCJ6j1Pbp/PFeZnFaVTHQS/lX5s9+OKpYOg6lT5Lqzm7vF7cKqD91DlVPHJ7n8frWlYWHTivbwFWNNWifNVsZWxtTnqvbZdF/XczGsP3j8f3f5V0jWH7x+P7v8AKvnM4xX+31Pl/wCko9zCw/do3bCw6cVoXwW3tvIUjzZhtx3Cnqf6f/qrny+rKq0keLXx1HA0+aer6Lq/+B3f66HK6mGvr7eCTEi7Yx2xnr261sCw/epx/AP51Wc1408VBR/lX5s+fp4iti5OpVd3+C8l/XrqV7Cw6cV0dlZKi7mwFUZJPQCtsJitj3KEUldmJdmxs5Stw4RmAIGCTjHtmq+oxte3s85B2kqEB7KBx615GZxTxtRzeun/AKSjnnxFKD5cNFOK6u+vpqtDdmXz76cv/BIY1HoFOKK6cudqcbdj4/FzlUxtRyd7Sa+SehbFtH5qf7g/nRXm57J/XIf4V+bPbwC90m1J/It4oEGPtG4M3oBjj8aK9HJ1dtvpYxz6vUp06dODspXv52sZLW0fmP8A8B/lRXlZxJ/X6ny/9JRwYVfu0f/Z";

function fromB64(s: string): Uint8Array {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function pixelsEqual(a: PixelBuffer, b: PixelBuffer, label: string): void {
  assert.equal(a.width, b.width, `${label} width`);
  assert.equal(a.height, b.height, `${label} height`);
  assert.deepEqual(a.data, b.data, `${label} pixels`);
}

function assertLossless(src: Uint8Array, label: string, progressive = false): Uint8Array {
  const out = transcodeJpeg(src, progressive ? { progressive: true } : undefined);
  pixelsEqual(decodeJpeg(src), decodeJpeg(out), label);
  const again = transcodeJpeg(out, progressive ? { progressive: true } : undefined);
  assert.deepEqual(again, out, `${label} idempotent`);
  return out;
}

function hasMarker(bytes: Uint8Array, code: number): boolean {
  let i = 0;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const m = bytes[i + 1];
    if (m === undefined || m === 0x00 || m === 0xff) {
      i += 1;
      continue;
    }
    if (m === code) {
      return true;
    }
    if (m === 0xd8 || m === 0xd9 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    if (m === 0xda) {
      return false;
    }
    const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    i += 2 + len;
  }
  return false;
}

function sofMarker(bytes: Uint8Array): number | undefined {
  let i = 0;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const m = bytes[i + 1];
    if (m === 0xc0 || m === 0xc2) {
      return m;
    }
    if (
      m === undefined ||
      m === 0x00 ||
      m === 0xff ||
      m === 0xd8 ||
      m === 0xd9 ||
      (m >= 0xd0 && m <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    i += 2 + len;
  }
  return undefined;
}

function sofComponentCount(bytes: Uint8Array): number | undefined {
  let i = 0;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const m = bytes[i + 1];
    if (m === 0xc0 || m === 0xc2) {
      return bytes[i + 9];
    }
    if (
      m === undefined ||
      m === 0x00 ||
      m === 0xff ||
      m === 0xd8 ||
      m === 0xd9 ||
      (m >= 0xd0 && m <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    i += 2 + len;
  }
  return undefined;
}

function dqtPrecision(bytes: Uint8Array): number | undefined {
  let i = 0;
  while (i + 4 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const m = bytes[i + 1];
    if (m === 0xdb) {
      return (bytes[i + 4] ?? 0) >> 4;
    }
    if (
      m === undefined ||
      m === 0x00 ||
      m === 0xff ||
      m === 0xd8 ||
      m === 0xd9 ||
      (m >= 0xd0 && m <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    i += 2 + len;
  }
  return undefined;
}

function findApp1Payload(bytes: Uint8Array): Uint8Array | undefined {
  let i = 0;
  while (i + 4 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const m = bytes[i + 1];
    if (m === 0xe1) {
      const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
      return bytes.subarray(i + 4, i + 2 + len);
    }
    if (
      m === undefined ||
      m === 0x00 ||
      m === 0xff ||
      m === 0xd8 ||
      m === 0xd9 ||
      (m >= 0xd0 && m <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    if (m === 0xda) {
      return undefined;
    }
    const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    i += 2 + len;
  }
  return undefined;
}

function spliceAfterSoi(jpeg: Uint8Array, segment: Uint8Array): Uint8Array {
  const out = new Uint8Array(jpeg.length + segment.length);
  out.set(jpeg.subarray(0, 2), 0);
  out.set(segment, 2);
  out.set(jpeg.subarray(2), 2 + segment.length);
  return out;
}

function expandFirstDqtTo16Bit(jpeg: Uint8Array): Uint8Array {
  let i = 0;
  while (i + 4 < jpeg.length) {
    if (jpeg[i] !== 0xff) {
      i += 1;
      continue;
    }
    const m = jpeg[i + 1];
    if (m === 0xdb) {
      const len = ((jpeg[i + 2] ?? 0) << 8) | (jpeg[i + 3] ?? 0);
      const info = jpeg[i + 4] ?? 0;
      if (info >> 4 !== 0 || len < 67) {
        throw new Error("expected 8-bit DQT");
      }
      const tableId = info & 0x0f;
      const vals = jpeg.subarray(i + 5, i + 5 + 64);
      const restStart = i + 2 + len;
      const newSeg = new Uint8Array(4 + 1 + 128);
      newSeg[0] = 0xff;
      newSeg[1] = 0xdb;
      newSeg[2] = 0x00;
      newSeg[3] = 131;
      newSeg[4] = 0x10 | tableId;
      for (let k = 0; k < 64; k++) {
        newSeg[5 + k * 2] = 0;
        newSeg[6 + k * 2] = vals[k] ?? 1;
      }
      const out = new Uint8Array(i + newSeg.length + (jpeg.length - restStart));
      out.set(jpeg.subarray(0, i), 0);
      out.set(newSeg, i);
      out.set(jpeg.subarray(restStart), i + newSeg.length);
      return out;
    }
    if (
      m === undefined ||
      m === 0x00 ||
      m === 0xff ||
      m === 0xd8 ||
      m === 0xd9 ||
      (m >= 0xd0 && m <= 0xd7)
    ) {
      i += 2;
      continue;
    }
    const len = ((jpeg[i + 2] ?? 0) << 8) | (jpeg[i + 3] ?? 0);
    i += 2 + len;
  }
  throw new Error("no DQT");
}

function fillPixels(
  width: number,
  height: number,
  pixel: (x: number, y: number) => readonly [number, number, number, number],
): PixelBuffer {
  const image = createPixelBuffer(width, height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixel(x, y);
      const o = (y * width + x) * 4;
      image.data[o] = r;
      image.data[o + 1] = g;
      image.data[o + 2] = b;
      image.data[o + 3] = a;
    }
  }
  return image;
}

function makeCmykJpeg(transform: number): Uint8Array {
  const out = new ByteWriter();
  writeMarker(out, 0xd8);
  writeApp14(out, transform);
  writeDqt(out, 0, STD_LUM_QUANT);
  writeDqt(out, 1, STD_CHR_QUANT);
  writeSof(out, false, 8, 8, [
    { id: 1, h: 1, v: 1, qTable: 0 },
    { id: 2, h: 1, v: 1, qTable: 1 },
    { id: 3, h: 1, v: 1, qTable: 1 },
    { id: 4, h: 1, v: 1, qTable: 1 },
  ]);
  const block = (dc: number): Int16Array => {
    const c = new Int16Array(64);
    c[0] = dc;
    c[1] = 3;
    c[8] = -2;
    return c;
  };
  const mk = (id: number, dc: number, tbl: number): ComponentCoeffs => ({
    coeffs: block(dc),
    blockCols: 1,
    scanCols: 1,
    scanRows: 1,
    h: 1,
    v: 1,
    id,
    dcTbl: tbl,
    acTbl: tbl,
  });
  encodeSequentialScans(out, [mk(1, 12, 0), mk(2, -4, 1), mk(3, 5, 1), mk(4, 20, 1)], 1, 1);
  writeMarker(out, 0xd9);
  return out.finish();
}

const FIXTURES: Array<{ name: string; b64: string }> = [
  { name: "baseline restart", b64: RESTART_JPEG },
  { name: "progressive 4:2:0", b64: PROGRESSIVE_JPEG },
  { name: "gray progressive", b64: GRAYPROGRESSIVE_JPEG },
  { name: "progressive 4:2:2", b64: PROGRESSIVE422_JPEG },
  { name: "progressive restart", b64: PROGRESSIVERESTART_JPEG },
  { name: "h1v2", b64: H1V2_JPEG },
];

test("EXIF orientation writer round-trips through the reader", () => {
  for (let ori = 1; ori <= 8; ori++) {
    const payload = buildExifOrientationPayload(ori);
    assert.equal(parseExifOrientation(payload), ori, `ori ${ori}`);
    assert.equal(payload[6], 0x4d);
    assert.equal(payload[7], 0x4d);
  }
  assert.throws(() => buildExifOrientationPayload(0), RangeError);
  assert.throws(() => buildExifOrientationPayload(9), RangeError);
});

test("transcodeJpeg is lossless and idempotent on libjpeg fixtures", () => {
  for (const f of FIXTURES) {
    const src = fromB64(f.b64);
    const out = assertLossless(src, f.name);
    assert.equal(sofMarker(out), 0xc0, `${f.name} baseline SOF`);
    assert.equal(hasMarker(out, 0xdd), false, `${f.name} no DRI`);
  }
});

test("transcodeJpeg progressive is lossless and idempotent", () => {
  for (const f of FIXTURES) {
    const src = fromB64(f.b64);
    const out = assertLossless(src, `${f.name} progressive`, true);
    assert.equal(sofMarker(out), 0xc2, `${f.name} SOF2`);
  }
});

test("gray transcode stays 1-component", () => {
  const out = transcodeJpeg(fromB64(GRAYPROGRESSIVE_JPEG));
  assert.equal(sofComponentCount(out), 1);
  assert.equal(hasMarker(out, 0xe0), true);
});

test("orientation 6 is re-emitted so decode stays upright", () => {
  const src = fillPixels(8, 4, (x) => (x < 4 ? [220, 20, 20, 255] : [20, 20, 220, 255]));
  const jpeg = encodeJpeg(src, { quality: 95, chroma: "4:4:4" });
  const payload = buildExifOrientationPayload(6);
  const app1 = new Uint8Array(4 + payload.length);
  app1[0] = 0xff;
  app1[1] = 0xe1;
  const len = payload.length + 2;
  app1[2] = (len >> 8) & 0xff;
  app1[3] = len & 0xff;
  app1.set(payload, 4);
  const withExif = spliceAfterSoi(jpeg, app1);
  const out = transcodeJpeg(withExif);
  const app1Out = findApp1Payload(out);
  assert.ok(app1Out !== undefined);
  assert.equal(parseExifOrientation(app1Out), 6);
  pixelsEqual(decodeJpeg(withExif), decodeJpeg(out), "orientation-6");
  assert.equal(decodeJpeg(out).width, 4);
  assert.equal(decodeJpeg(out).height, 8);
  assertLossless(withExif, "orientation-6 idempotent");
});

test("Adobe APP14 is re-emitted and 4-component files stay 4-component", () => {
  for (const transform of [0, 2]) {
    const src = makeCmykJpeg(transform);
    assert.equal(sofComponentCount(src), 4);
    const out = transcodeJpeg(src);
    assert.equal(hasMarker(out, 0xee), true, `adobe transform ${transform}`);
    assert.equal(hasMarker(out, 0xe0), false, "no JFIF on 4-comp");
    assert.equal(sofComponentCount(out), 4);
    pixelsEqual(decodeJpeg(src), decodeJpeg(out), `cmyk t${transform}`);
    const prog = transcodeJpeg(src, { progressive: true });
    assert.equal(sofMarker(prog), 0xc2);
    pixelsEqual(decodeJpeg(src), decodeJpeg(prog), `cmyk prog t${transform}`);
    assert.deepEqual(transcodeJpeg(out), out);
  }
});

test("16-bit DQT is copied and still decodes identically", () => {
  const src = encodeJpeg(
    fillPixels(8, 8, (x, y) => [x * 20, y * 20, 90, 255]),
    {
      quality: 80,
      chroma: "4:4:4",
    },
  );
  const wide = expandFirstDqtTo16Bit(src);
  assert.equal(dqtPrecision(wide), 1);
  pixelsEqual(decodeJpeg(src), decodeJpeg(wide), "16-bit dqt decode");
  const out = transcodeJpeg(wide);
  assert.equal(dqtPrecision(out), 1);
  pixelsEqual(decodeJpeg(wide), decodeJpeg(out), "16-bit dqt transcode");
});

test("maxPixels is enforced", () => {
  const jpeg = encodeJpeg(createPixelBuffer(8, 8), { quality: 50 });
  assert.throws(() => transcodeJpeg(jpeg, { maxPixels: 10 }), /maxPixels/);
});

test("generated encodeJpeg roundtrips through transcode", () => {
  const src = fillPixels(17, 13, (x, y) => [(x * 13) & 255, (y * 17) & 255, 40, 255]);
  for (const chroma of ["4:2:0", "4:2:2", "4:4:4"] as const) {
    const jpeg = encodeJpeg(src, { quality: 70, chroma });
    assertLossless(jpeg, `encode ${chroma}`);
    assertLossless(jpeg, `encode ${chroma} prog`, true);
  }
});

function markerCodes(bytes: Uint8Array): number[] {
  const codes: number[] = [];
  let i = 0;
  while (i + 1 < bytes.length) {
    if (bytes[i] !== 0xff) {
      i += 1;
      continue;
    }
    const m = bytes[i + 1];
    if (m === undefined || m === 0x00 || m === 0xff) {
      i += 1;
      continue;
    }
    codes.push(m);
    if (m === 0xda || m === 0xd9) {
      break;
    }
    if (m === 0xd8 || (m >= 0xd0 && m <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = ((bytes[i + 2] ?? 0) << 8) | (bytes[i + 3] ?? 0);
    i += 2 + len;
  }
  return codes;
}

function stripApp0(jpeg: Uint8Array): Uint8Array {
  if (jpeg[0] !== 0xff || jpeg[1] !== 0xd8 || jpeg[2] !== 0xff || jpeg[3] !== 0xe0) {
    throw new Error("expected SOI APP0");
  }
  const len = ((jpeg[4] ?? 0) << 8) | (jpeg[5] ?? 0);
  const out = new Uint8Array(jpeg.length - (2 + len));
  out.set(jpeg.subarray(0, 2), 0);
  out.set(jpeg.subarray(2 + 2 + len), 2);
  return out;
}

function adobeApp14(transform: number): Uint8Array {
  const seg = new Uint8Array(16);
  seg[0] = 0xff;
  seg[1] = 0xee;
  seg[2] = 0x00;
  seg[3] = 0x0e;
  seg[4] = 0x41;
  seg[5] = 0x64;
  seg[6] = 0x6f;
  seg[7] = 0x62;
  seg[8] = 0x65;
  seg[9] = 0x00;
  seg[10] = 100;
  seg[15] = transform;
  return seg;
}

/** libjpeg-turbo 3.2.0 `cjpeg -quality 80 -rgb` of an 8×4 red/blue split. */
const CJPEG_RGB =
  "/9j/7gAOQWRvYmUAZAAAAAAA/9sAQwAGBAUGBQQGBgUGBwcGCAoQCgoJCQoUDg8MEBcUGBgXFBYWGh0lHxobIxwWFiAsICMmJykqKRkfLTAtKDAlKCko/8AAEQgABAAIA1IRAEcRAEIRAP/EAB8AAAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYXGBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/aAAwDUgBHAEIAAD8Aqfta/wDMq/8Ab3/7Rr5vqp+yV/zNX/bp/wC1q//Z";

test("transcodeJpeg omits JFIF on Adobe transform-0 RGB and keeps pixels", () => {
  const srcPixels = fillPixels(8, 4, (x) => (x < 4 ? [220, 20, 20, 255] : [20, 20, 220, 255]));
  const ycbcr = encodeJpeg(srcPixels, { quality: 80, chroma: "4:4:4" });
  const adobeRgb = spliceAfterSoi(stripApp0(ycbcr), adobeApp14(0));
  assert.equal(hasMarker(adobeRgb, 0xe0), false);
  assert.equal(hasMarker(adobeRgb, 0xee), true);
  const out = transcodeJpeg(adobeRgb);
  assert.equal(hasMarker(out, 0xe0), false, "no APP0 on Adobe RGB");
  assert.equal(hasMarker(out, 0xee), true, "APP14 kept");
  assert.ok(markerCodes(out)[1] !== 0xe0);
  pixelsEqual(decodeJpeg(adobeRgb), decodeJpeg(out), "adobe-rgb in-code");

  const cjpegRgb = fromB64(CJPEG_RGB);
  assert.equal(hasMarker(cjpegRgb, 0xe0), false);
  assert.equal(hasMarker(cjpegRgb, 0xee), true);
  const cjpegOut = transcodeJpeg(cjpegRgb);
  assert.equal(hasMarker(cjpegOut, 0xe0), false, "no APP0 on cjpeg -rgb");
  assert.equal(hasMarker(cjpegOut, 0xee), true);
  pixelsEqual(decodeJpeg(cjpegRgb), decodeJpeg(cjpegOut), "cjpeg-rgb");
});

test("transcodeJpeg still writes JFIF for YCbCr (Adobe transform 1 or none)", () => {
  const src = encodeJpeg(createPixelBuffer(8, 8), { quality: 50 });
  assert.equal(hasMarker(src, 0xe0), true);
  assert.equal(hasMarker(transcodeJpeg(src), 0xe0), true);
  const adobeYcbcr = spliceAfterSoi(src, adobeApp14(1));
  const out = transcodeJpeg(adobeYcbcr);
  assert.equal(hasMarker(out, 0xe0), true);
  assert.equal(hasMarker(out, 0xee), true);
  pixelsEqual(decodeJpeg(adobeYcbcr), decodeJpeg(out), "adobe YCbCr");
});

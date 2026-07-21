import { Effect, Schema } from "effect";

export class CryptoError
  extends Schema.TaggedErrorClass<CryptoError>()("CryptoError", {
    cause: Schema.Defect(),
  }) {}

export const sha256Hex = Effect.fn("sha256Hex")(function* (value: string) {
  const data = new TextEncoder().encode(value);
  const hash = yield* Effect.tryPromise({
    try: () => crypto.subtle.digest("SHA-256", data),
    catch: (cause) => CryptoError.make({ cause }),
  });
  return Array.from(
    new Uint8Array(hash),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
});

export function uniqueSorted(values: ReadonlyArray<string>): Array<string> {
  return Array.from(new Set(values.filter((value) => value.length > 0))).sort((
    left,
    right,
  ) => left.localeCompare(right));
}

export function addUnique(values: Array<string>, value: string): void {
  if (value.length === 0 || values.includes(value)) return;
  values.push(value);
}

export function stripAccents(value: unknown): string {
  return String(value).replace(
    /[ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝàáâãäåçèéêëìíîïñòóôõöùúûüýÿŒœÆæ]/g,
    (char) => ACCENTS[char] ?? char,
  );
}

const ACCENTS: Readonly<Record<string, string>> = {
  À: "A",
  Á: "A",
  Â: "A",
  Ã: "A",
  Ä: "A",
  Å: "A",
  Ç: "C",
  È: "E",
  É: "E",
  Ê: "E",
  Ë: "E",
  Ì: "I",
  Í: "I",
  Î: "I",
  Ï: "I",
  Ñ: "N",
  Ò: "O",
  Ó: "O",
  Ô: "O",
  Õ: "O",
  Ö: "O",
  Ù: "U",
  Ú: "U",
  Û: "U",
  Ü: "U",
  Ý: "Y",
  à: "a",
  á: "a",
  â: "a",
  ã: "a",
  ä: "a",
  å: "a",
  ç: "c",
  è: "e",
  é: "e",
  ê: "e",
  ë: "e",
  ì: "i",
  í: "i",
  î: "i",
  ï: "i",
  ñ: "n",
  ò: "o",
  ó: "o",
  ô: "o",
  õ: "o",
  ö: "o",
  ù: "u",
  ú: "u",
  û: "u",
  ü: "u",
  ý: "y",
  ÿ: "y",
  Œ: "OE",
  œ: "oe",
  Æ: "AE",
  æ: "ae",
};

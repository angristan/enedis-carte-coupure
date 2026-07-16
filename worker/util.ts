export async function sha256Hex(value: string) {
  const data = new TextEncoder().encode(value);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function parseDuration(value: string | undefined, fallbackSeconds: number) {
  if (!value) return fallbackSeconds;
  const match = String(value).trim().match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/);
  if (!match) return fallbackSeconds;

  const amount = Number(match[1]);
  const unit = match[2] || "s";
  if (!Number.isFinite(amount) || amount < 0) return fallbackSeconds;

  switch (unit) {
    case "ms":
      return amount / 1000;
    case "s":
      return amount;
    case "m":
      return amount * 60;
    case "h":
      return amount * 3600;
    case "d":
      return amount * 86400;
    default:
      return fallbackSeconds;
  }
}

export async function mapLimit<T, R>(items: T[], limit: number, callback: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    for (;;) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= items.length) return;
      results[index] = await callback(items[index], index);
    }
  }

  const workers = [];
  for (let index = 0; index < Math.min(limit, items.length); index += 1) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

export function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

export function addUnique(values: string[], value: string): void {
  if (!value || values.includes(value)) return;
  values.push(value);
}

export function stripAccents(value: unknown): string {
  return String(value).replace(/[ÀÁÂÃÄÅÇÈÉÊËÌÍÎÏÑÒÓÔÕÖÙÚÛÜÝàáâãäåçèéêëìíîïñòóôõöùúûüýÿŒœÆæ]/g, (char) => ACCENTS[char] || char);
}

const ACCENTS: Record<string, string> = {
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

import { stripAccents } from "./util.js";

export interface ParsedLocalisation {
  readonly label: string;
  readonly normalizedName: string;
  readonly normalizedKey: string;
  readonly city: string;
  readonly postcode: string;
}

const STREET_PREFIX_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/^\/+\s*/, ""],
  [/^ET\s+/, ""],
  [/^PARKING\s+VINCI\/ROSSINI\s+\d+\s+/, ""],
  [/^R[.\s]+/, "RUE "],
  [/^BD[.\s]+/, "BOULEVARD "],
  [/^BLD[.\s]+/, "BOULEVARD "],
  [/^AV(?:E)?[.\s]+/, "AVENUE "],
  [/^PL[.\s]+/, "PLACE "],
  [/^PAS[.\s]+/, "PASSAGE "],
  [/^IMP[.\s]+/, "IMPASSE "],
  [/^SQ[.\s]+/, "SQUARE "],
  [/\bFBG\b/g, "FAUBOURG"],
  [/\bFG\b/g, "FAUBOURG"],
  [/\bST\b/g, "SAINT"],
  [/\bSTE\b/g, "SAINTE"],
];

const NUMBERED_STREET_PREFIXES = [
  "RUE ",
  "R. ",
  "R ",
  "BD ",
  "BOULEVARD ",
  "AV ",
  "AVENUE ",
  "PL ",
  "PLACE ",
  "PAS ",
  "PASSAGE ",
  "IMP ",
  "IMPASSE ",
  "SQ ",
  "SQUARE ",
  "VILLA ",
  "CITE ",
  "EGLISE ",
];

const LOWERCASE_TITLE_WORDS = new Set([
  "a",
  "au",
  "aux",
  "d",
  "de",
  "des",
  "du",
  "et",
  "l",
  "la",
  "le",
  "les",
]);

export function parseLocalisation(
  localisation: string,
  fallbackCity: string,
): ParsedLocalisation {
  const parts = localisation.split(/,(.*)/s);
  const rawStreet = (parts[0] ?? "").trim();
  const rawCity = (parts[1] ?? fallbackCity).trim();
  const postcode = rawCity.match(/\((\d{5})\)/)?.[1] ??
    rawStreet.match(/\b(75\d{3})\b/)?.[1] ?? "";
  const city = rawCity.replace(/\([^)]*\)/g, "").trim() || fallbackCity ||
    "Paris";
  const normalizedName = normalizeStreet(rawStreet);

  return {
    label: titleCase(normalizedName),
    normalizedName,
    normalizedKey: stripAccents(normalizedName).toUpperCase(),
    city: titleCase(city),
    postcode,
  };
}

export function normalizeStreet(input: string): string {
  let value = stripAccents(input).toUpperCase().replaceAll("\u00a0", " ")
    .replace(/[()]/g, " ").replace(/\s+/g, " ").trim();

  for (const [pattern, replacement] of STREET_PREFIX_REPLACEMENTS) {
    value = stripLeadingAddressNumber(value.replace(pattern, replacement));
  }

  return value.replace(/\s+/g, " ").trim();
}

function stripLeadingAddressNumber(value: string): string {
  const clean = value.trim().replace(/^\/+\s*/, "");
  const rest = clean.match(/^\d+(?:[.\s]\d+)*[A-Z]?\s+(.+)$/)?.[1]?.trim();
  const beginsWithStreetType = rest !== undefined &&
    NUMBERED_STREET_PREFIXES.some((prefix) => rest.startsWith(prefix));

  return beginsWithStreetType ? rest : clean;
}

function titleCase(value: string): string {
  return value.toLowerCase().split(/\s+/).filter(Boolean).map((word, index) =>
    index > 0 && LOWERCASE_TITLE_WORDS.has(word)
      ? word
      : word.charAt(0).toUpperCase() + word.slice(1)
  ).join(" ");
}

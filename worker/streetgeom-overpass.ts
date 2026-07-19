import { Schema } from "effect";
import type { Bounds, Position } from "./geo.js";
import { OverpassPayloadSchema, type StreetGeometry } from "./models.js";
import { overpassBBox } from "./geo.js";
import { stripAccents, uniqueSorted } from "./util.js";

const MAX_BATCH_SIZE = 36;

const CHARACTER_VARIANTS: Readonly<Record<string, string>> = {
  A: "[AÀÁÂÃÄÅàáâãäå]",
  C: "[CÇç]",
  E: "[EÈÉÊËèéêë]",
  I: "[IÌÍÎÏìíîï]",
  N: "[NÑñ]",
  O: "[OÒÓÔÕÖòóôõö]",
  U: "[UÙÚÛÜùúûü]",
  Y: "[YÝŸýÿ]",
};

const NAME_SEPARATOR_PATTERN = `[ ./'’-]+`;
const REGEX_CHARACTER_PATTERN = /[\\^$.*+?()[\]{}|]/g;

type OverpassPayload = Schema.Schema.Type<typeof OverpassPayloadSchema>;

type GroupedStreet = {
  readonly source: string;
  readonly osmNames: Array<string>;
  readonly lines: Array<Array<Position>>;
};

export const streetKey = (value: string): string =>
  stripAccents(value.trim()).toUpperCase();

export function buildStreetLookupQuery(
  bounds: Bounds,
  rawNameKeys: ReadonlyArray<string>,
): string {
  const nameKeys = uniqueSorted(rawNameKeys);

  if (nameKeys.length === 0) {
    return `[out:json][timeout:45];way["highway"]["name"](${
      overpassBBox(bounds)
    });out tags geom;`;
  }

  const queryParts: Array<string> = [];

  for (let start = 0; start < nameKeys.length; start += MAX_BATCH_SIZE) {
    const namePattern = nameKeys
      .slice(start, start + MAX_BATCH_SIZE)
      .map(nameRegexFromKey)
      .filter((value) => value.length > 0)
      .join("|");

    if (namePattern.length > 0) {
      queryParts.push(
        `way["highway"]["name"~"^ *(${
          escapeOverpassRegex(namePattern)
        }) *$",i](${overpassBBox(bounds)});`,
      );
    }
  }

  return `[out:json][timeout:45];(${queryParts.join("")});out tags geom;`;
}

export function streetGeometriesFromPayload(
  payload: OverpassPayload,
  source: string,
): Readonly<Record<string, StreetGeometry>> {
  const grouped = new Map<string, GroupedStreet>();

  for (const element of payload.elements ?? []) {
    if (
      element.type !== "way" ||
      element.geometry === undefined ||
      element.geometry.length < 2
    ) {
      continue;
    }

    const name = element.tags?.name?.trim() ?? "";
    const key = streetKey(name);
    if (key.length === 0) continue;

    const current = grouped.get(key) ?? {
      source,
      osmNames: [],
      lines: [],
    };

    if (!current.osmNames.includes(name)) current.osmNames.push(name);

    current.lines.push(
      element.geometry.map((point) => ({
        lat: point.lat,
        lng: point.lon,
      })),
    );
    grouped.set(key, current);
  }

  const geometries: Record<string, StreetGeometry> = {};

  for (const [key, result] of grouped) {
    geometries[key] = {
      status: "ok",
      source: result.source,
      osmNames: result.osmNames.sort((left, right) =>
        left.localeCompare(right)
      ),
      lines: result.lines,
    };
  }

  return geometries;
}

function nameRegexFromKey(key: string): string {
  return key
    .trim()
    .split(/\s+/)
    .map(tokenRegex)
    .filter((value) => value.length > 0)
    .join(NAME_SEPARATOR_PATTERN);
}

function tokenRegex(token: string): string {
  return Array.from(
    token,
    (character) =>
      CHARACTER_VARIANTS[character] ?? escapeRegexCharacter(character),
  ).join("");
}

function escapeRegexCharacter(character: string): string {
  return /[A-Z0-9]/.test(character)
    ? character
    : character.replace(REGEX_CHARACTER_PATTERN, "\\$&");
}

function escapeOverpassRegex(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

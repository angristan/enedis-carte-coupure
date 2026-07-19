import type { EnedisAddress, OutageAddress, Street } from "./models.js";
import { addUnique } from "./util.js";

export interface MutableOutage {
  id: string;
  status: string;
  type: string;
  etatElectrique: number;
  codeInsee: string;
  dateCoupure: string;
  dateRealimentation: string;
  nbFoyersCoupes: number;
  addresses: Array<OutageAddress>;
}

export interface MutableStreet {
  key: string;
  label: string;
  normalizedName: string;
  city: string;
  postcode: string;
  localisations: Array<string>;
  outageIds: Array<string>;
  outageTypes: Array<string>;
  firstSeenAt: string;
  estimatedRestoreAt: string;
  nbFoyersCoupes: number;
  geocode?: Street["geocode"];
  geometry?: Street["geometry"];
}

export function mergeStreetValue(
  map: Map<string, MutableStreet>,
  street: Street,
): void {
  const current = map.get(street.key);

  if (current === undefined) {
    map.set(street.key, {
      ...street,
      localisations: [...street.localisations],
      outageIds: [...street.outageIds],
      outageTypes: [...street.outageTypes],
    });
    return;
  }

  for (const value of street.localisations) {
    addUnique(current.localisations, value);
  }
  for (const value of street.outageIds) {
    addUnique(current.outageIds, value);
  }
  for (const value of street.outageTypes) {
    addUnique(current.outageTypes, value);
  }

  current.nbFoyersCoupes += street.nbFoyersCoupes;
  current.firstSeenAt = earliestFrenchDate(
    current.firstSeenAt,
    street.firstSeenAt,
  );
  current.estimatedRestoreAt = latestFrenchDate(
    current.estimatedRestoreAt,
    street.estimatedRestoreAt,
  );
  current.geocode ??= street.geocode;
  current.geometry ??= street.geometry;
}

export function mergeOutageValue(
  map: Map<string, MutableOutage>,
  key: string,
  outage: MutableOutage,
): void {
  const current = map.get(key);

  if (current === undefined) {
    map.set(key, { ...outage, addresses: [...outage.addresses] });
    return;
  }

  current.nbFoyersCoupes += outage.nbFoyersCoupes;
  current.dateCoupure = earliestFrenchDate(
    current.dateCoupure,
    outage.dateCoupure,
  );
  current.dateRealimentation = latestFrenchDate(
    current.dateRealimentation,
    outage.dateRealimentation,
  );

  for (const address of outage.addresses) {
    addUniqueAddress(current.addresses, address);
  }
}

export function earliestFrenchDate(
  current: string,
  candidate: string,
): string {
  return candidate.length > 0 &&
      (current.length === 0 ||
        parseFrenchDate(candidate) < parseFrenchDate(current))
    ? candidate
    : current;
}

export function latestFrenchDate(
  current: string,
  candidate: string,
): string {
  return candidate.length > 0 &&
      (current.length === 0 ||
        parseFrenchDate(candidate) > parseFrenchDate(current))
    ? candidate
    : current;
}

export function uniqueAddresses(
  addresses: ReadonlyArray<EnedisAddress>,
): Array<OutageAddress> {
  const output: Array<OutageAddress> = [];

  for (const address of addresses) {
    addUniqueAddress(output, address);
  }

  return output;
}

export function addUniqueAddress(
  addresses: Array<OutageAddress>,
  address: EnedisAddress | OutageAddress,
): void {
  const item = {
    localisation: address.localisation ?? "",
    nbFoyersCoupes: numberValue(address.nbFoyersCoupes),
  };
  const alreadyPresent = addresses.some((existing) =>
    existing.localisation === item.localisation &&
    existing.nbFoyersCoupes === item.nbFoyersCoupes
  );

  if (!alreadyPresent) {
    addresses.push(item);
  }
}

export function numberValue(value: string | number | undefined): number {
  const parsed = Number(value);

  return Number.isFinite(parsed) ? parsed : 0;
}

function parseFrenchDate(value: string): number {
  const match = value.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2})$/);

  return match === null ? 0 : new Date(
    Number(match[3]),
    Number(match[2]) - 1,
    Number(match[1]),
    Number(match[4]),
    Number(match[5]),
  ).getTime();
}

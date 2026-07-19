import { Context, Effect, Layer } from "effect";
import type { EnedisPayload, EnedisQuery } from "./models.js";
import { EnedisPayloadSchema } from "./models.js";
import { RawHttp } from "./platform.js";
import type { UpstreamError } from "./errors.js";

export const ENEDIS_ORIGIN = "https://www.enedis.fr";
export const ENEDIS_ENDPOINT = `${ENEDIS_ORIGIN}/panne-interruption-ajax`;
export const ENEDIS_RESULT_PAGE =
  `${ENEDIS_ORIGIN}/resultat-panne-interruption`;

const DEFAULT_LONGITUDE = "2.347";
const DEFAULT_LATITUDE = "48.859";
const DEFAULT_DEPARTMENT = "75";

export const DEFAULT_QUERY: EnedisQuery = {
  insee: "75056",
  type: "municipality",
  adresse: "Paris",
  CPVille: "Paris 75001",
  name: "Paris",
  district: "",
  city: "Paris",
};

export class Enedis extends Context.Service<Enedis, {
  readonly fetch: (
    query: EnedisQuery,
  ) => Effect.Effect<EnedisPayload, UpstreamError>;
}>()("Enedis") {}

export const EnedisLive = Layer.effect(Enedis)(Effect.gen(function* () {
  const http = yield* RawHttp;
  const fetchPayload = Effect.fn("Enedis.fetch")(
    function* (query: EnedisQuery) {
      const endpoint = new URL(ENEDIS_ENDPOINT);
      endpoint.searchParams.set("insee", query.insee);
      endpoint.searchParams.set("type", query.type);
      endpoint.searchParams.set("adresse", query.adresse);
      endpoint.searchParams.set("CPVille", query.CPVille);
      endpoint.searchParams.set("name", query.name);
      endpoint.searchParams.set("district", query.district);
      endpoint.searchParams.set("city", query.city);

      return yield* http.json({
        provider: "Enedis",
        operation: "enedis.fetch",
        url: endpoint,
        attributes: { "enedis.insee": query.insee, "enedis.city": query.city },
        init: {
          headers: {
            Accept: "application/json, text/plain, */*",
            Referer: resultURL(query),
            "User-Agent": "enedis-carte-coupure/1.0",
          },
        },
      }, EnedisPayloadSchema);
    },
  );

  return { fetch: fetchPayload };
}));

export function queryFromValues(
  values: Pick<URLSearchParams, "get" | "has">,
): EnedisQuery {
  const get = (name: string, fallback: string): string =>
    values.has(name) ? values.get(name) ?? fallback : fallback;

  const longitude = values.get("longitude") ?? values.get("long") ?? undefined;
  const latitude = values.get("latitude") ?? values.get("lat") ?? undefined;
  const department = values.get("department") ?? values.get("departement") ??
    undefined;

  return {
    insee: get("insee", DEFAULT_QUERY.insee),
    type: get("type", DEFAULT_QUERY.type),
    adresse: get("adresse", DEFAULT_QUERY.adresse),
    CPVille: get("CPVille", DEFAULT_QUERY.CPVille),
    name: get("name", DEFAULT_QUERY.name),
    district: get("district", DEFAULT_QUERY.district),
    city: get("city", DEFAULT_QUERY.city),
    ...(longitude === undefined ? {} : { longitude }),
    ...(latitude === undefined ? {} : { latitude }),
    ...(department === undefined ? {} : { department }),
  };
}

export function resultURL(query: EnedisQuery): string {
  const url = new URL(ENEDIS_RESULT_PAGE);
  url.searchParams.set("adresse", query.adresse);
  url.searchParams.set("insee", query.insee);
  url.searchParams.set("long", query.longitude ?? DEFAULT_LONGITUDE);
  url.searchParams.set("lat", query.latitude ?? DEFAULT_LATITUDE);
  url.searchParams.set("type", query.type);
  url.searchParams.set("CPVille", query.CPVille);
  url.searchParams.set("street", "");
  url.searchParams.set("name", query.name);
  url.searchParams.set("departement", query.department ?? DEFAULT_DEPARTMENT);
  url.searchParams.set("district", query.district);
  url.searchParams.set("city", query.city);
  return url.toString();
}

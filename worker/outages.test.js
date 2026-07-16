import { describe, expect, it } from "vitest";
import { normalizeStreet, parseLocalisation } from "./outages.js";

describe("outage street parsing", () => {
  it("normalizes street abbreviations and leading address numbers", () => {
    expect(normalizeStreet("12 R. de Longchamp")).toBe("RUE DE LONGCHAMP");
    expect(normalizeStreet("BD Saint-Michel")).toBe("BOULEVARD SAINT-MICHEL");
  });

  it("extracts city and postcode from Enedis localisation labels", () => {
    expect(parseLocalisation("R. de Longchamp, PARIS 16 (75116)", "Paris")).toEqual({
      label: "Rue de Longchamp",
      normalizedName: "RUE DE LONGCHAMP",
      normalizedKey: "RUE DE LONGCHAMP",
      city: "Paris 16",
      postcode: "75116",
    });
  });
});

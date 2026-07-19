export { hasMapLayer, streetFeatureCollection } from "./streetFeatures.js";
export type { StreetFeatureCollection } from "./streetFeatures.js";

export {
  hasGeometry,
  mergeConnectedLines,
  mergedGeometryLines,
  streetBounds,
} from "./streetLines.js";
export type { Coordinate } from "./streetLines.js";

export { boundsInsideCommuneContours, pointInGeometry } from "./spatial.js";

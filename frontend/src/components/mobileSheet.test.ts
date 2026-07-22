import { describe, expect, it } from "vitest";
import {
  mobileSheetPosition,
  shouldOpenMobileSheet,
} from "./mobileSheet.js";

describe("mobileSheetPosition", () => {
  it("moves an open sheet from its expanded position", () => {
    expect(mobileSheetPosition(true, 500, 180)).toBe(180);
  });

  it("moves a closed sheet upward from its resting position", () => {
    expect(mobileSheetPosition(false, 500, -180)).toBe(320);
  });

  it("clamps movement to the sheet travel", () => {
    expect(mobileSheetPosition(true, 500, -100)).toBe(0);
    expect(mobileSheetPosition(false, 500, 100)).toBe(500);
  });
});

describe("shouldOpenMobileSheet", () => {
  it("settles toward the closest resting position", () => {
    expect(
      shouldOpenMobileSheet({
        position: 200,
        travel: 500,
        velocityY: 0.1,
        distanceY: 100,
      }),
    ).toBe(true);
    expect(
      shouldOpenMobileSheet({
        position: 300,
        travel: 500,
        velocityY: -0.1,
        distanceY: -100,
      }),
    ).toBe(false);
  });

  it("honors a deliberate flick regardless of position", () => {
    expect(
      shouldOpenMobileSheet({
        position: 450,
        travel: 500,
        velocityY: -0.5,
        distanceY: -50,
      }),
    ).toBe(true);
    expect(
      shouldOpenMobileSheet({
        position: 50,
        travel: 500,
        velocityY: 0.5,
        distanceY: 50,
      }),
    ).toBe(false);
  });

  it("ignores a fast movement that is too short to be deliberate", () => {
    expect(
      shouldOpenMobileSheet({
        position: 20,
        travel: 500,
        velocityY: 0.5,
        distanceY: 20,
      }),
    ).toBe(true);
  });
});

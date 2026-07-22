export const MOBILE_SHEET_DRAG_THRESHOLD = 6;

const FLICK_VELOCITY_PX_PER_MS = 0.45;
const FLICK_MIN_DISTANCE_PX = 24;

export function mobileSheetPosition(
  open: boolean,
  travel: number,
  deltaY: number,
): number {
  const start = open ? 0 : travel;
  return Math.min(travel, Math.max(0, start + deltaY));
}

interface MobileSheetSettleOptions {
  readonly position: number;
  readonly travel: number;
  readonly velocityY: number;
  readonly distanceY: number;
}

export function shouldOpenMobileSheet(
  { position, travel, velocityY, distanceY }: MobileSheetSettleOptions,
): boolean {
  if (Math.abs(distanceY) >= FLICK_MIN_DISTANCE_PX) {
    if (velocityY <= -FLICK_VELOCITY_PX_PER_MS) return true;
    if (velocityY >= FLICK_VELOCITY_PX_PER_MS) return false;
  }
  return position < travel / 2;
}

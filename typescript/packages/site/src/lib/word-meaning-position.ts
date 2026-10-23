interface Rectangle {
  bottom: number;
  left: number;
  right: number;
  top: number;
}

export interface MeaningViewport {
  height: number;
  left: number;
  top: number;
  width: number;
}

interface MeaningPanelPosition {
  left: number;
  maxHeight: number;
  top: number;
}

const CLEARANCE = 12;
const GAP = 8;

export function wordMeaningPosition(
  word: Rectangle,
  viewport: MeaningViewport,
  panel: { width: number; height: number },
  headerBottom: number
): MeaningPanelPosition {
  const left = viewport.left + CLEARANCE;
  const right = viewport.left + viewport.width - CLEARANCE;
  const headerTop = Math.max(viewport.top, headerBottom) + CLEARANCE;
  // Keep the meaning above its word, including when the word is just below
  // the sticky header. The top layer may cover that header instead of
  // jumping below the word or squeezing the meaning into an unreadable strip.
  const top =
    word.top - GAP - headerTop >= Math.min(panel.height, 48)
      ? headerTop
      : viewport.top + CLEARANCE;
  const maxHeight = Math.max(0, word.top - GAP - top);
  return {
    left: Math.max(
      left,
      Math.min((word.left + word.right - panel.width) / 2, right - panel.width)
    ),
    top: Math.max(top, word.top - GAP - Math.min(panel.height, maxHeight)),
    maxHeight,
  };
}

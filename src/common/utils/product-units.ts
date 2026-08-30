export function normalizePiecesPerBox(value?: number | null): number | undefined {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return undefined;
  return Math.floor(n);
}

export function totalPieces(
  boxQuantity: number,
  pieceQuantity: number,
  piecesPerBox?: number | null,
): number {
  const boxes = Math.max(0, Math.trunc(boxQuantity) || 0);
  const pieces = Math.max(0, Math.trunc(pieceQuantity) || 0);
  const ppb = normalizePiecesPerBox(piecesPerBox);
  if (boxes > 0 && !ppb) {
    throw new Error('piecesPerBox required when boxQuantity > 0');
  }
  return boxes * (ppb ?? 0) + pieces;
}

export function resolveCheckoutQuantities(input: {
  quantity?: number;
  boxQuantity?: number;
  pieceQuantity?: number;
  piecesPerBox?: number | null;
}): {
  boxQuantity: number;
  pieceQuantity: number;
  piecesPerBox?: number;
  quantity: number;
} {
  const ppb = normalizePiecesPerBox(input.piecesPerBox);
  const hasBox = input.boxQuantity != null;
  const hasPiece = input.pieceQuantity != null;

  if (hasBox || hasPiece) {
    const boxQuantity = Math.max(0, Math.trunc(input.boxQuantity ?? 0));
    const pieceQuantity = Math.max(0, Math.trunc(input.pieceQuantity ?? 0));
    if (boxQuantity === 0 && pieceQuantity === 0) {
      throw new Error('At least one of boxQuantity or pieceQuantity must be > 0');
    }
    if (boxQuantity > 0 && !ppb) {
      throw new Error('Product has no piecesPerBox configured');
    }
    const quantity = totalPieces(boxQuantity, pieceQuantity, ppb);
    if (quantity < 1) {
      throw new Error('Total quantity must be at least 1');
    }
    return {
      boxQuantity,
      pieceQuantity,
      ...(ppb ? { piecesPerBox: ppb } : {}),
      quantity,
    };
  }

  const quantity = Math.trunc(Number(input.quantity));
  if (!Number.isFinite(quantity) || quantity < 1) {
    throw new Error('quantity must be at least 1');
  }
  return {
    boxQuantity: 0,
    pieceQuantity: quantity,
    ...(ppb ? { piecesPerBox: ppb } : {}),
    quantity,
  };
}

export function splitStockToKorDona(
  stock: number,
  piecesPerBox?: number | null,
): { boxes: number; pieces: number } {
  const total = Math.max(0, Math.trunc(stock) || 0);
  const ppb = normalizePiecesPerBox(piecesPerBox);
  if (!ppb) return { boxes: 0, pieces: total };
  return {
    boxes: Math.floor(total / ppb),
    pieces: total % ppb,
  };
}

/** Kor/dona matni. `alwaysShowBoth` — omborda: 4 kor / 0 dona */
export function formatUnitsUz(
  boxQuantity: number,
  pieceQuantity: number,
  opts?: { alwaysShowBoth?: boolean },
): string {
  const box = Math.max(0, Math.trunc(boxQuantity) || 0);
  const piece = Math.max(0, Math.trunc(pieceQuantity) || 0);
  if (opts?.alwaysShowBoth || box > 0) {
    return `${box} kor / ${piece} dona`;
  }
  if (piece > 0) return `${piece} dona`;
  return '0 dona';
}

export function formatNakladnoyCase(
  boxQuantity?: number | null,
  pieceQuantity?: number | null,
): string {
  const box = Math.max(0, Math.trunc(boxQuantity ?? 0));
  const piece = Math.max(0, Math.trunc(pieceQuantity ?? 0));
  const parts: string[] = [];
  if (box > 0) parts.push(`${box} kor.`);
  if (piece > 0) parts.push(`${piece} dona.`);
  if (!parts.length) return '—';
  return parts.join(' / ');
}

export function stockAdjustDelta(
  unit: 'box' | 'piece',
  amount: number,
  piecesPerBox?: number | null,
): number {
  const qty = Math.trunc(amount);
  if (!Number.isFinite(qty) || qty === 0) return 0;
  if (unit === 'piece') return qty;
  const ppb = normalizePiecesPerBox(piecesPerBox);
  if (!ppb) {
    throw new Error('piecesPerBox required for box stock adjustment');
  }
  return qty * ppb;
}

export function stockAdjustTotalDelta(
  adjust: { boxAmount?: number; pieceAmount?: number },
  piecesPerBox?: number | null,
): number {
  let delta = 0;
  const boxAmount = Math.trunc(adjust.boxAmount ?? 0);
  const pieceAmount = Math.trunc(adjust.pieceAmount ?? 0);
  if (boxAmount !== 0) {
    delta += stockAdjustDelta('box', boxAmount, piecesPerBox);
  }
  if (pieceAmount !== 0) {
    delta += stockAdjustDelta('piece', pieceAmount, piecesPerBox);
  }
  return delta;
}

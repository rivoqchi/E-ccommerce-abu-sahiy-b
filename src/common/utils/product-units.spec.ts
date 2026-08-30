import {
  formatNakladnoyCase,
  formatUnitsUz,
  resolveCheckoutQuantities,
  splitStockToKorDona,
  stockAdjustDelta,
  totalPieces,
} from './product-units';

describe('product-units', () => {
  it('computes total pieces', () => {
    expect(totalPieces(2, 3, 4)).toBe(11);
    expect(totalPieces(0, 5, 4)).toBe(5);
  });

  it('splits stock to kor and dona', () => {
    expect(splitStockToKorDona(11, 4)).toEqual({ boxes: 2, pieces: 3 });
    expect(splitStockToKorDona(11)).toEqual({ boxes: 0, pieces: 11 });
  });

  it('formats uz and nakladnoy strings', () => {
    expect(formatUnitsUz(3, 3)).toBe('3 kor / 3 dona');
    expect(formatUnitsUz(4, 0)).toBe('4 kor / 0 dona');
    expect(formatUnitsUz(0, 5)).toBe('5 dona');
    expect(formatUnitsUz(0, 5, { alwaysShowBoth: true })).toBe('0 kor / 5 dona');
    expect(formatNakladnoyCase(3, 3)).toBe('3 kor. / 3 dona.');
    expect(formatNakladnoyCase(0, 0)).toBe('—');
  });

  it('resolves legacy quantity checkout', () => {
    expect(resolveCheckoutQuantities({ quantity: 5 })).toEqual({
      boxQuantity: 0,
      pieceQuantity: 5,
      quantity: 5,
    });
  });

  it('resolves box and piece checkout', () => {
    expect(
      resolveCheckoutQuantities({
        boxQuantity: 2,
        pieceQuantity: 1,
        piecesPerBox: 4,
      }),
    ).toEqual({
      boxQuantity: 2,
      pieceQuantity: 1,
      piecesPerBox: 4,
      quantity: 9,
    });
  });

  it('computes stock adjust delta', () => {
    expect(stockAdjustDelta('box', 5, 4)).toBe(20);
    expect(stockAdjustDelta('piece', 7)).toBe(7);
  });
});

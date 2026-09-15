// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fitCount, useFitCount } from './use-fit-count';

it('draws every item when they all fit, the always-there control included', () => {
  expect(fitCount([100, 100, 100], 400, 8, 60)).toBe(3);
  // The counter is not needed when nothing is left out, so it is not budgeted then.
  expect(fitCount([100, 100, 100], 384, 8, 60, 40)).toBe(3);
});

it('keeps room for the counter and the trailing control once something is left out', () => {
  // Three items are 316 wide, which fits 320 alone but not with a 60 control after them.
  expect(fitCount([100, 100, 100], 320, 8, 60)).toBe(2);
  // Two items plus gap plus control is 276: fine. A third would need 344.
  expect(fitCount([100, 100, 100, 100], 320, 8, 60)).toBe(2);
  // With a 40 counter to fit as well, two items need 324, so only one is drawn.
  expect(fitCount([100, 100, 100, 100], 320, 8, 60, 40)).toBe(1);
});

it('can show none when even the first item and the controls do not fit', () => {
  expect(fitCount([300], 200, 8, 60)).toBe(0);
});

it('needs no trailing room when nothing trails', () => {
  expect(fitCount([100, 100, 100], 316, 8, 0)).toBe(3);
  expect(fitCount([100, 100, 100], 315, 8, 0)).toBe(2);
  // Only the counter to keep room for: two items plus gap plus counter is 256.
  expect(fitCount([100, 100, 100], 256, 8, 0, 40)).toBe(2);
});

it('handles an empty row', () => {
  expect(fitCount([], 0, 8, 60)).toBe(0);
});

// jsdom has no layout, so the sizes are pinned on the elements the hook measures.
function sized(width: number, name: 'clientWidth' | 'offsetWidth' = 'offsetWidth') {
  return (element: HTMLElement | null) => {
    if (element) Object.defineProperty(element, name, { value: width, configurable: true });
  };
}

function Row({
  widths,
  available,
  counter,
  trailing,
}: {
  widths: number[];
  available: number;
  counter: number;
  trailing: number;
}) {
  const { containerRef, counterRef, trailingRef, itemRef, fit } = useFitCount(
    widths.length,
    widths.join(',')
  );
  return (
    <div
      ref={element => {
        containerRef.current = element;
        sized(available, 'clientWidth')(element);
      }}
    >
      {widths.map((width, index) => (
        <span
          key={index}
          ref={element => {
            itemRef(index)(element);
            sized(width)(element);
          }}
        />
      ))}
      <span
        ref={element => {
          counterRef.current = element;
          sized(counter)(element);
        }}
      />
      <span
        ref={element => {
          trailingRef.current = element;
          sized(trailing)(element);
        }}
      />
      <output>{fit}</output>
    </div>
  );
}

beforeEach(() => {
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it('budgets the counter from the first measurement, before anything has overflowed', () => {
  // Three 150 chips are 466 wide; with the 70 create chip they need 544, so all fit in 560.
  render(<Row widths={[150, 150, 150]} available={560} counter={38} trailing={70} />);
  expect(screen.getByRole('status').textContent).toBe('3');
  cleanup();
  // A fourth chip overflows. Three chips plus the counter and the create chip need 590, so the
  // row shows two, not three with the create chip clipped off the end.
  render(<Row widths={[150, 150, 150, 150]} available={560} counter={38} trailing={70} />);
  expect(screen.getByRole('status').textContent).toBe('2');
});

import { useCallback, useReducer, useRef } from 'react';

/**
 * State that is updated synchronously. Several key events can arrive in one tick, before React
 * re-renders; plain useState would hand every handler the same stale value and drop keystrokes.
 */
export function useLive<T>(initial: T): [() => T, (update: T | ((prev: T) => T)) => void] {
  const ref = useRef(initial);
  const [, rerender] = useReducer((n: number) => n + 1, 0);
  const set = useCallback((update: T | ((prev: T) => T)) => {
    ref.current = typeof update === 'function' ? (update as (prev: T) => T)(ref.current) : update;
    rerender();
  }, []);
  return [() => ref.current, set];
}

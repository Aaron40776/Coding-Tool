import { Text } from 'ink';
import { useEffect, useState } from 'react';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
/** Every tick repaints the frame, so keep it slow: 5 fps reads as "working" without hammering the terminal. */
export const SPINNER_INTERVAL_MS = 200;

/** `still` shows a static marker: nothing is running (e.g. waiting for the user), so nothing should redraw. */
export function Spinner({ color, still }: { color?: string; still?: boolean }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (still) return undefined;
    const t = setInterval(() => setI((n) => (n + 1) % FRAMES.length), SPINNER_INTERVAL_MS);
    return () => clearInterval(t);
  }, [still]);
  return <Text color={color}>{still ? '●' : FRAMES[i]}</Text>;
}

import { Text } from 'ink';
import { useEffect, useState } from 'react';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export function Spinner({ color }: { color?: string }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setI((n) => (n + 1) % FRAMES.length), 90);
    return () => clearInterval(t);
  }, []);
  return <Text color={color}>{FRAMES[i]}</Text>;
}

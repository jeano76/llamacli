import React, { useEffect, useState } from "react";
import { Text } from "ink";

// Reported directly: llamacli flickers on Windows, one line in particular
// (the input prompt's own row — exactly where this spinner sits) and
// occasionally stray special characters show up there too. The original
// Braille-pattern frames (⠋⠙⠹...) are Unicode glyphs whose rendered column
// width and font coverage varies a lot more across terminal fonts than
// plain ASCII does — a common source of exactly this symptom: many Windows
// console/terminal fonts either lack full Braille coverage or compute its
// width slightly differently than Ink does, so every frame swap nudges the
// rest of the line sideways by a fraction of a character, which reads as
// flicker rather than a smooth spin. Plain ASCII has none of that
// ambiguity on any platform or font.
const FRAMES = ["|", "/", "-", "\\"];

/** ASCII spinner shown in front of the prompt while the agent is working (§6). */
export function Spinner({ active }: { active: boolean }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setFrame((f) => (f + 1) % FRAMES.length), 80);
    return () => clearInterval(id);
  }, [active]);

  if (!active) return <Text> </Text>;
  return <Text color="cyan">{FRAMES[frame]}</Text>;
}

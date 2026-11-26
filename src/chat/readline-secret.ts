/** Keep type-ahead masked between prompts and secrets out of interactive history (#629, I-03). */
import type { Interface } from "node:readline";

type MaskableReadline = Interface & { _writeToOutput(text: string): void; history: string[] };

export function protectReadline(rl: Interface, output: NodeJS.WritableStream): (secret: boolean) => (line: string) => void {
  const masked = rl as MaskableReadline;
  const original = masked._writeToOutput.bind(masked);
  const mask = (text: string): void => {
    if (text === "\r\n" || text === "\n" || text === "\r") original(text);
    else output.write("*");
  };
  masked._writeToOutput = mask;
  rl.on("line", (line) => {
    if (masked._writeToOutput === mask) masked.history = masked.history.filter((entry) => entry !== line);
    masked._writeToOutput = mask;
  });
  return (secret) => {
    masked._writeToOutput = secret ? mask : original;
    return () => { masked._writeToOutput = mask; };
  };
}

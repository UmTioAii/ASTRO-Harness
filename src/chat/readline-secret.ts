/** Mask one readline answer and keep it out of interactive history (#629, I-03). */
import type { Interface } from "node:readline";

type MaskableReadline = Interface & {
  _writeToOutput(text: string): void;
  history: string[];
};

export function maskSecretReadline(
  rl: Interface,
  output: NodeJS.WritableStream,
): (line: string) => void {
  const masked = rl as MaskableReadline;
  const original = masked._writeToOutput.bind(masked);
  masked._writeToOutput = (text) => {
    if (text === "\r\n" || text === "\n" || text === "\r") original(text);
    else output.write("*");
  };
  return (line) => {
    masked._writeToOutput = original;
    masked.history = masked.history.filter((entry) => entry !== line);
  };
}

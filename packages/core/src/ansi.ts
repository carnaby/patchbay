/**
 * Terminal escape sequences (colours, cursor moves, window titles) as a script's or a monitor's output carries them.
 * Shown as they are they read "[31mFAILED[0m", so text that ends up on screen or in a snapshot is cleaned here once,
 * the same way for both renderers.
 */
// CSI ("\x1b[31m", also cut off at the end), OSC up to BEL or ST (or the end), and the two-character escapes.
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
const ANSI = /\u001b(?:\[[0-?]*[ -/]*(?:[@-~]|$)|\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|[@-Z\\-_])/g;

/** The text without escape sequences; a stray ESC left over is dropped too. For one value, not a whole document. */
export function stripAnsi(text: string): string {
  return text.includes('\u001b') ? text.replace(ANSI, '').replaceAll('\u001b', '') : text;
}

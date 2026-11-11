/**
 * How long an overlay opened by a tap during a presentation may stay without input. Long enough for a reader on a
 * touch wall to keep it by touching the screen now and then, short enough that an unattended board recovers from a
 * stray tap.
 */
export const UNATTENDED_CLOSE_MS = 30_000;

/**
 * Only an overlay opened while a presentation ran is closed for the viewer: one maximised before Present was chosen
 * on purpose and stays the view, and once the presentation ends the page is an ordinary one again.
 */
export function closesUnattended(openedWhilePresenting: boolean, presenting: boolean): boolean {
  return openedWhilePresenting && presenting;
}

/** One pending close; `poke` restarts the count (input), `stop` cancels it. */
export function unattendedTimer(close: () => void, ms = UNATTENDED_CLOSE_MS) {
  let timer = setTimeout(close, ms);
  return {
    poke() {
      clearTimeout(timer);
      timer = setTimeout(close, ms);
    },
    stop() {
      clearTimeout(timer);
    },
  };
}

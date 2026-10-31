import { describe, expect, it } from 'vitest';
import { BusyError } from './gate.ts';
import { BodyTimeoutError, BodyTooLargeError, LargeBodyReceiver, withReceivedBody } from './json-body.ts';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** A request whose body arrives in `chunks` of `size` bytes, `everyMs` apart; `stall` stops it before the end. */
function trickle(chunks: number, size: number, everyMs: number, stall = false) {
  let sent = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (sent === chunks) {
        if (stall) await new Promise(() => {});
        controller.close();
        return;
      }
      if (sent > 0) await sleep(everyMs);
      sent++;
      controller.enqueue(new Uint8Array(size).fill(65));
    },
  });
  return new Request('http://x/api/dashboards/d/files', {
    method: 'POST',
    body,
    duplex: 'half',
  } as RequestInit);
}

const fast = { graceMs: 100, checkMs: 20, minBytesPerSec: 50_000, maxMs: 1000 };

describe('LargeBodyReceiver', () => {
  it('reads a whole body and counts its bytes until it is released', async () => {
    const receiver = new LargeBodyReceiver(fast);
    const body = await receiver.receive(trickle(4, 1000, 1), 'ip:a', 10_000);
    expect(body.bytes).toBe(4000);
    expect(receiver.stats()).toEqual({ bytes: 4000, bodies: 1 });
    body.release();
    body.release();
    expect(receiver.stats()).toEqual({ bytes: 0, bodies: 0 });
    const text = await withReceivedBody(trickle(0, 0, 0), body.chunks).text();
    expect(text).toBe('A'.repeat(4000));
  });

  it('refuses a body that arrives too slowly with 408, and one that never ends', async () => {
    const receiver = new LargeBodyReceiver(fast);
    // 1 KB every 50 ms: 20 KB/s against a floor of 50 KB/s.
    const slow = receiver.receive(trickle(100, 1000, 50), 'ip:slow', 1_000_000);
    await expect(slow).rejects.toBeInstanceOf(BodyTimeoutError);
    await expect(slow).rejects.toMatchObject({ status: 408 });
    // Fast enough at first, then nothing more: the total time runs out.
    const stalled = receiver.receive(trickle(1, 200_000, 1, true), 'ip:stall', 1_000_000);
    await expect(stalled).rejects.toBeInstanceOf(BodyTimeoutError);
    expect(receiver.stats()).toEqual({ bytes: 0, bodies: 0 });
  });

  it('refuses a body larger than allowed while it arrives', async () => {
    // A pace no machine can miss: this is about size, and on a loaded test run the pace check must not fire first.
    const receiver = new LargeBodyReceiver({ ...fast, graceMs: 60_000, minBytesPerSec: 1, maxMs: 60_000 });
    await expect(receiver.receive(trickle(5, 1000, 1), 'ip:a', 3000)).rejects.toBeInstanceOf(
      BodyTooLargeError,
    );
    expect(receiver.stats().bytes).toBe(0);
  });

  it('limits bodies per client and bytes held across the server', async () => {
    const receiver = new LargeBodyReceiver({ ...fast, maxPerClient: 2, maxHeldBytes: 5000 });
    const one = await receiver.receive(trickle(2, 1000, 1), 'ip:a', 10_000);
    const two = await receiver.receive(trickle(2, 1000, 1), 'ip:a', 10_000);
    await expect(receiver.receive(trickle(2, 1000, 1), 'ip:a', 10_000)).rejects.toBeInstanceOf(BusyError);
    // Another client may send, but not past what the server holds.
    await expect(receiver.receive(trickle(2, 1000, 1), 'ip:b', 10_000)).rejects.toBeInstanceOf(BusyError);
    one.release();
    const three = await receiver.receive(trickle(2, 1000, 1), 'ip:b', 10_000);
    expect(receiver.stats()).toEqual({ bytes: 4000, bodies: 2 });
    two.release();
    three.release();
  });

  it('lets a slow sender cost only what it sent: others receive at once beside it', async () => {
    const receiver = new LargeBodyReceiver({ ...fast, maxHeldBytes: 50_000 });
    const slow = expect(receiver.receive(trickle(100, 500, 50), 'ip:slow', 1_000_000)).rejects.toBeInstanceOf(
      BodyTimeoutError,
    );
    await sleep(30);
    const other = await receiver.receive(trickle(10, 4000, 1), 'ip:other', 1_000_000);
    expect(other.bytes).toBe(40_000);
    other.release();
    await slow;
  });
});

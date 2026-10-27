/**
 * A response whose body streams `totalMb` MiB of spaces without ever holding
 * more than one 1 MiB chunk (the same chunk is enqueued again), with no
 * Content-Length: a server that keeps sending. `pulled()` says how many
 * chunks the reader asked for before it stopped.
 */
export function endlessResponse(totalMb: number, init: ResponseInit = { status: 200 }) {
  const chunk = new Uint8Array(1024 * 1024).fill(0x20);
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= totalMb) {
        controller.close();
        return;
      }
      pulled++;
      controller.enqueue(chunk);
    },
  });
  return { response: new Response(body, init), pulled: () => pulled };
}

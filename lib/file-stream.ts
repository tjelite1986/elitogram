import fs from "node:fs";

// A file on disk as a web ReadableStream that survives the client hanging up.
//
// `Readable.toWeb(fs.createReadStream(...))` does not: when a browser abandons
// a response — every time a clip scrolls out of the Videos feed, every seek
// that starts a new Range request — the response's controller is closed while
// the file stream keeps reading, and the next chunk lands on a closed
// controller. That throws ERR_INVALID_STATE ("Invalid state: Controller is
// already closed") from a place no route handler can catch: it surfaces as an
// uncaughtException, 64 of them in 48 hours on the live app.
//
// So the file is pumped by hand. An enqueue that throws means the reader is
// gone and the file stream is destroyed; cancel() — the orderly version of the
// same thing — does likewise; and backpressure is honoured by pausing until
// pull() asks for more, so a 300 MB video is never read faster than it is sent.
export function fileStream(
  filePath: string,
  options: { start?: number; end?: number } = {},
  signal?: AbortSignal
): ReadableStream<Uint8Array> {
  const file = fs.createReadStream(filePath, options);
  const stop = () => file.destroy();
  signal?.addEventListener("abort", stop);

  return new ReadableStream<Uint8Array>({
    start(controller) {
      file.on("data", (chunk) => {
        try {
          controller.enqueue(new Uint8Array(chunk as Buffer));
        } catch {
          // Nobody is reading any more; stop touching the disk.
          file.destroy();
          return;
        }
        if ((controller.desiredSize ?? 1) <= 0) file.pause();
      });
      file.on("end", () => {
        try {
          controller.close();
        } catch {
          /* already closed by an abort */
        }
      });
      file.on("error", (err) => {
        try {
          controller.error(err);
        } catch {
          /* the reader is already gone; the error has nowhere to go */
        }
      });
      file.on("close", () => signal?.removeEventListener("abort", stop));
    },
    pull() {
      file.resume();
    },
    cancel() {
      file.destroy();
    },
  });
}

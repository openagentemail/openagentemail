/** Per-seat wake serialization. Distinct seats do not share a lock. */

export class SeatSerializer {
  private locks = new Map<string, Promise<void>>();

  run<T>(seat: string, work: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(seat) ?? Promise.resolve();
    const current = prev.catch(() => undefined).then(work);
    this.locks.set(
      seat,
      current.then(
        () => undefined,
        () => undefined,
      ),
    );
    return current;
  }
}

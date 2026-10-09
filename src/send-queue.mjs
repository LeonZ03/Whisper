// A bounded, memory-only queue of encrypted envelopes. Never retry an ambiguous upload.
export class SendQueue {
  constructor({ send, onState = () => {}, limit = 20 }) {
    this.send = send; this.onState = onState; this.limit = limit;
    this.pending = []; this.active = null; this.epoch = 0;
  }
  get size() { return this.pending.length + (this.active ? 1 : 0); }
  state(job, state, error) { try { this.onState(job.envelope, job.context, state, error); } catch {} }
  enqueue(envelope, context) {
    if (this.size >= this.limit) throw Error('发送队列已满，请稍等再发送。');
    const promise = new Promise((resolve, reject) => {
      const job = { envelope, context, resolve, reject, epoch: this.epoch };
      this.pending.push(job); this.state(job, 'queued');
    });
    queueMicrotask(() => { void this.drain(); });
    return promise;
  }
  cancel() {
    this.epoch++;
    const error = Object.assign(Error('发送已取消。'), { name: 'AbortError' });
    for (const job of this.pending.splice(0)) { this.state(job, 'cancelled'); job.reject(error); }
  }
  async drain() {
    if (this.active) return;
    while (this.pending.length) {
      const job = this.pending.shift(); this.active = job;
      try {
        if (job.envelope.expiresAt <= Date.now()) throw Object.assign(Error('排队的消息已到期，未发送。'), { notSent: true });
        this.state(job, 'sending');
        await this.send(job.envelope, job.context);
        if (job.epoch !== this.epoch) throw Object.assign(Error('发送已取消。'), { name: 'AbortError' });
        this.state(job, 'sent'); job.resolve(job.envelope.id);
      } catch (error) {
        this.state(job, job.epoch !== this.epoch || error.name === 'AbortError' ? 'cancelled' : 'failed', error);
        job.reject(error);
      } finally { this.active = null; }
    }
  }
}

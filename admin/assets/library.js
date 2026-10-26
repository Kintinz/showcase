export function projectPage(projects, query, requestedPage) {
  const search = query.trim().toLocaleLowerCase('vi');
  const matches = projects.filter(p => `${p.name} ${p.slug}`.toLocaleLowerCase('vi').includes(search));
  const pages = Math.max(1, Math.ceil(matches.length / 24)), page = Math.min(pages, Math.max(1, requestedPage));
  return { page, pages, total: matches.length, start: (page - 1) * 24, items: matches.slice((page - 1) * 24, page * 24) };
}

export class PollScheduler {
  #run; #hasWork; #visible; #setTimer; #clearTimer; #timer; #attempt = 0; #version = 0; #running = false; #again = false;
  constructor({ run, hasWork, visible = () => !document.hidden, setTimer = setTimeout, clearTimer = clearTimeout }) {
    this.#run = run; this.#hasWork = hasWork; this.#visible = visible; this.#setTimer = setTimer.bind(globalThis); this.#clearTimer = clearTimer.bind(globalThis);
  }
  pause() { this.#version++; this.#clearTimer(this.#timer); this.#timer = null; this.#again = false; }
  stop() { this.pause(); this.#attempt = 0; }
  async start() {
    this.pause(); this.#attempt = 0;
    if (!this.#visible() || !this.#hasWork()) return;
    if (this.#running) { this.#again = true; return; }
    await this.#tick();
  }
  async #tick() {
    this.#timer = null;
    if (!this.#visible() || !this.#hasWork()) return;
    const version = this.#version; this.#running = true;
    try { await this.#run(); }
    finally {
      this.#running = false;
      if (this.#again) { this.#again = false; await this.#tick(); }
      else if (version === this.#version && this.#visible() && this.#hasWork()) {
        const delay = [12000, 20000, 30000][Math.min(this.#attempt++, 2)];
        this.#timer = this.#setTimer(() => this.#tick(), delay);
      }
    }
  }
}

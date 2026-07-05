// Drives playback through a full CipherTrace at a configurable tick rate
// (spec 5.1: "throttles rendering to a configurable tick-rate... rather
// than rendering every frame at native speed"). The server returns the
// complete trace synchronously (see docs/API.md); all pacing is a
// client-side concern, controlled by play/pause/step/fps here.
export class TracePlayer {
  constructor({ onTick }) {
    this.steps = [];
    this.index = -1;
    this.playing = false;
    this.fps = 12;
    this.timer = null;
    this.onTick = onTick;
  }

  load(steps) {
    this.pause();
    this.steps = steps;
    this.index = -1;
    this.step();
  }

  play() {
    if (this.playing || this.index >= this.steps.length - 1) return;
    this.playing = true;
    this.scheduleNext();
  }

  pause() {
    this.playing = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  step() {
    if (this.index < this.steps.length - 1) this.index += 1;
    this.onTick(this.index, this.steps.length);
  }

  setFps(fps) {
    this.fps = Math.max(1, Math.min(60, fps));
  }

  scheduleNext() {
    if (!this.playing) return;
    this.timer = setTimeout(() => {
      if (this.index >= this.steps.length - 1) {
        this.pause();
        return;
      }
      this.step();
      this.scheduleNext();
    }, 1000 / this.fps);
  }
}

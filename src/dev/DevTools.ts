import type { Game } from '../core/Game';

/**
 * Console helpers for testing (exposed as `window.dev`). The preview pane
 * starves requestAnimationFrame, so tests step the game by hand.
 */
export function installDevTools(game: Game): void {
  const dev = {
    game,
    /** Run n frames of dt seconds without rAF. */
    step(n = 1, dt = 1 / 60) {
      game.running = false;
      for (let i = 0; i < n; i++) game.frame(dt);
    },
    /**
     * Put the main storm so its tornado sits `dist` metres down the road
     * ahead (south), spawn it, and fast-forward it to the mature phase.
     */
    tornadoView(dist = 3000, rating = 3, lateral = 300) {
      const g = game;
      const s = g.weather.storms[0];
      const car = g.vehicle.pos;
      s.x = car.x + lateral;
      s.z = car.z + dist;
      s.vx = 8;
      s.vz = -5;
      s.intensity = 1;
      s.meso = 1;
      s.stage = 'tornadic';
      s.hasTornado = true;
      g.tornadoes.clear();
      const t = g.tornadoes.spawn(s, { rating });
      t.phase = 'mature';
      t.phaseTime = 0;
      t.presence = 1;
      t.debris = 1;
      t.condensation = t.params.visibility;
      t.radius = t.params.coreRadius;
      // Other storms out of the way.
      for (const o of g.weather.storms) if (o !== s) o.x += 40000;
      g.weather.local.cover = 0.3;
      dev.step(2);
    },
    look(yaw = 0, pitch = 0) {
      game.rig.yaw = yaw;
      game.rig.pitch = pitch;
      dev.step(2);
    },
    strike(cg = true) {
      const s = game.weather.storms[0];
      if (s) game.lightning.strike(s, cg);
    },
    mute() {
      (game as unknown as { audio?: { setMuted(m: boolean): void } }).audio?.setMuted(true);
    },
  };
  (window as unknown as { dev: typeof dev }).dev = dev;
}

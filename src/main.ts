import './styles/main.css';
import { Game } from './core/Game';
import { installDevTools } from './dev/DevTools';
import { loadChaserModel } from './vehicle/ChaserModel';
import { buildVehicleModel, type VehicleParts } from './vehicle/VehicleModel';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLElement;

const loading = document.createElement('div');
loading.className = 'loading';
loading.textContent = 'LOADING';
uiRoot.appendChild(loading);

async function boot(): Promise<void> {
  let parts: VehicleParts;
  try {
    parts = await loadChaserModel();
  } catch (e) {
    console.warn('[boot] chase SUV model unavailable, using the built-in placeholder', e);
    parts = buildVehicleModel();
  }
  const game = new Game(canvas, uiRoot, parts);
  (window as unknown as { game: Game }).game = game;
  if (import.meta.env.DEV || new URLSearchParams(location.search).has('dev')) installDevTools(game);
  loading.remove();
  game.start();
  game.showIntro();
}

void boot();

import './styles/main.css';
import { Game } from './core/Game';
import { installDevTools } from './dev/DevTools';

const canvas = document.getElementById('game-canvas') as HTMLCanvasElement;
const uiRoot = document.getElementById('ui-root') as HTMLElement;
const game = new Game(canvas, uiRoot);
(window as unknown as { game: Game }).game = game;
if (import.meta.env.DEV || new URLSearchParams(location.search).has('dev')) installDevTools(game);
game.start();

import { App } from './app';

const canvas = document.getElementById('canvas');
const hudElement = document.getElementById('hud');

if (!(canvas instanceof HTMLCanvasElement)) {
  throw new Error('#canvas is missing from index.html');
}
if (hudElement === null) {
  throw new Error('#hud is missing from index.html');
}

const app = new App(canvas, hudElement, location.search);
app.start();

// Debug handle: `__app.currentUrl()` in the console yields a link that
// reproduces exactly what is on screen.
window.__app = app;

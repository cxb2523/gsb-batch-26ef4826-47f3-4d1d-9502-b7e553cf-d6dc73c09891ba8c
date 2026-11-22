# Examples

## `site/` — the playable page

A single static page, no bundler, no assets.

```bash
npm run serve              # from the repo root: builds + serves :8080
# then open http://localhost:8080/examples/site/
```

`examples/site/game/main.ts` is the browser glue: it binds input, drives the
game loop from `requestAnimationFrame`, and renders. It imports the pure modules
from `src/` — the build step (`tools/build-site.mjs`) transpiles those into
`examples/site/game/src/*.js` so the browser loads plain ES modules.

Everything worth reading about the game lives in `src/`; the page only wires it
up.

## Headless check

```bash
npm run acceptance
```

Serves the site, loads it in headless Chrome, drives the real `Game` through a
debug hook, and asserts that the canvas paints, the player moves, physics is
frame-rate independent, and a personal best reaches `localStorage`. If Chrome or
Edge isn't installed the check prints `SKIP` and exits 0.

## Running the modules directly

Node can execute the TypeScript sources directly (Node >= 22.6, built-in type
stripping). For example, run the bot over the whole course:

```bash
node -e "
import('./src/bot/bot.ts').then(async ({ runBot }) => {
  const { buildCourse } = await import('./src/game/course.ts');
  console.log(runBot(buildCourse()));
});
"
```

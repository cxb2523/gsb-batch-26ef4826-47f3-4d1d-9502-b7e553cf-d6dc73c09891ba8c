# Stock simulation check

Verifies that the stock simulation (the carved heightmap in the 3D view) depends only on
the carving settings, the earlier jobs and the animation position — not on the order you
changed things or how far a move had been carved when you did. It runs the viewer's own
`parser.js` and `stock-sim.js`, so it checks exactly the code the viewer uses.

## What it checks

1. **Hide / show a tool.** Hiding a tool and showing it again gives the same heightmap as
   never hiding it, and the hidden tool's cuts are gone while it's hidden.
2. **Change the settings mid-animation.** Changing the hidden tools (or the earlier jobs)
   part way through the animation gives the same heightmap as carving straight to that
   position with the new settings, and the carving progress is at that position — not the
   old `carvedIndex`. Nothing flashes back to uncut stock.
3. **Dirty region.** After a settings change only the vertex rows and columns that actually
   changed are marked dirty, so the renderer re-uploads just the tiles over them.
4. **Moves carved part way.** A move carved in steps as the animation advances is carved
   exactly as one carved in a single go.
5. **Earlier jobs.** Adding or removing earlier jobs mid-animation matches building the
   stock with them (or without them) from the start.
6. **Resource lifecycle.** Rebuilding the simulator deletes the old tiles' buffers and the
   tool and box meshes, dropping their references; `destroy()` frees everything.

## Run it in Node

```sh
node tools/stock-sim-check/check.mjs                # the sample file and the viewer demo
node tools/stock-sim-check/check.mjs path/to/file.nc
```

With no files it uses `examples/stock_sim_demo.nc` and (if present) the last two files of
`examples/viewer-demo`, which chain with `PriorJob` comments. Exits non-zero if any check
fails.

## Run it in a browser

Serve the repository so the page can fetch the sample G-code (for example
`npx serve .`, or any static file server), then open:

- `tools/stock-sim-check/check.html` — the same checks as one page, using the viewer's
  scripts loaded as plain globals (as the viewer loads them). It also runs the resource
  lifecycle check against a counted stand-in for WebGL.
- `tools/stock-sim-check/check3d.html` — draws a carved stock with the real
  `StockMeshRenderer` in WebGL, changes the hidden tools mid-animation, and compares the
  pixels with a simulator built with those settings from the start. It also counts how many
  tiles are re-uploaded.

Both print PASS/FAIL to the page.

## Files

- `checks.js` — the checks (no Node or DOM APIs; the viewer's classes are passed in).
- `check.mjs` — the Node entry point: loads `src/js/gcode-expander.js`, `parser.js` and
  `stock-sim.js` into a `vm` sandbox, parses the G-code, runs `checks.js`, and adds the
  resource lifecycle check with a fake WebGL context.
- `browser.js` — the browser entry point for `check.html`.
- `check.html`, `check3d.html` — the two pages.

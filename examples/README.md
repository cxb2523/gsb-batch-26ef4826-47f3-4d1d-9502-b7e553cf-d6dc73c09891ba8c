# r-audio examples

The files in this directory constitute a demo web app where you can test the examples and experiment. To launch the demo app, run `npm run dev`.

Every example has notes/explanations embedded as HTML along the `r-audio` components.

## Lifecycle example

`lifecycle.js` (open `#lifecycle` after `npm run dev`) is an interactive check
of the connection lifecycle: it re-renders the graph from checkboxes and a
schedule window, prints the live connection list, and lets you watch a
scheduled `ROscillator` end, get rebuilt and re-scheduled from the latest
props.

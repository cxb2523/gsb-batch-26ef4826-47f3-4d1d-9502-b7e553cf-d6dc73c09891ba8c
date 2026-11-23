# r-audio
A library of React components for building [Web Audio](https://www.w3.org/TR/webaudio/) graphs.

## Objectives
👉 make Web Audio graph code more readable and representative of the graph shape

👉 make it easier to create reusable graphs

👉 make state management easier with React's one-way data bindings and single source of state

👉 represent any arbitrary directed graphs in JSX

👉 support all non-deprecated audio nodes including `AudioWorklet`

👉 allow interspersed HTML components in audio components

## Installation

```bash
npm install r-audio
```

## Usage example

Stereo waveshaper + amplitude modulation on a WAV loop
```jsx
<RAudioContext debug={true} onInit={ctx => this.audioContext = ctx}>
  <RPipeline>
    <RBufferSource buffer={this.state.buffer} loop/>
    <RSplitChannels channelCount={2}>
      <RPipeline>
        <RWaveShaper curve={this.makeDistortionCurve(200)} />
        <RConvolver buffer={this.state.buffer} />
        <RDynamicsCompressor threshold={-50} knee={40}/>
        <RGain gain={.5} />
      </RPipeline>
      <RPipeline>
        <ROscillator frequency={1} type="sine" detune={0} connectToParam="gain" />
        <RGain gain={1} />
      </RPipeline>
    </RSplitChannels>
  </RPipeline>
</RAudioContext>
```

## Useful links
- [Full usage examples](https://github.com/bbc/r-audio/tree/master/examples)
- [API Reference](https://github.com/bbc/r-audio/wiki/API-Reference)

## Development setup

```bash
npm install
npm run dev
```

The demo page will be served at `localhost:8080`. Use a recent version of Chrome or Firefox for the best experience.

Firefox Web Audio developer tool is especially handy (bear in mind Firefox does not support AudioWorklet as of 17 April 2018).

> If `webpack-dev-server` fails to start on a recent Node.js with an
> `ERR_OSSL_EVP_UNSUPPORTED` / `spdy` error (both come from webpack 4), run it
> with the legacy OpenSSL provider:
> `NODE_OPTIONS=--openssl-legacy-provider npm run dev`.

## Connection lifecycle

The AudioNode graph is kept in sync with the JSX at all times:

- **Re-rendering / changing `children`** reconciles each node's outgoing
  connections edge by edge - connections which did not change stay untouched,
  new ones are added once, and ones which are no longer referenced (including
  those pointing at a node which was replaced) are removed. This also applies
  to `destination`/`identifier` changes passed down by `RPipeline`, `RSplit`,
  `RCycle` and `RExtensible`.
- **Unmounting** removes both the node's outgoing edges and every incoming
  edge that targets it, so an upstream node can never keep feeding a destroyed
  node or one of its `AudioParam`s.
- **Scheduled sources** (`ROscillator`, `RBufferSource`, `RConstantSource`)
  rebuild the underlying AudioNode when it ends (Web Audio sources can only be
  started once). The rebuilt node receives the latest props (params and
  `start`/`stop` window), takes the place of the old node in the graph, and is
  re-scheduled from the current props:
  - a `stop` time still in the future replays the remaining window from now;
  - a `start` time still in the future is honoured as a pending schedule;
  - a window which has fully elapsed is *not* restarted (so a finished one-shot
    source does not loop forever); the node stays connected and silent until a
    later props update schedules it again.

`disconnect` is always called with the most precise arguments the target allows
(`disconnect(node, output, input)` for nodes, `disconnect(param)` for
`AudioParam` targets) so unrelated connections are never torn down.

## Tests

```bash
npm test            # lifecycle tests against a deterministic Web Audio mock
npm run test:browser # the same connection-level checks in a real browser
```

`npm test` uses `jsdom` + `react-test-renderer` and a mock Web Audio
implementation (`test/mock-audio.js`) which models `connect`/`disconnect` and
scheduled sources precisely, so "the source ended" can be reproduced by moving
the mocked `AudioContext.currentTime` forward. It covers the destination,
children and identifier changes, connection teardown and the
scheduled-source rebuild.

`npm run test:browser` bundles `test/browser/check.js` and runs it in
Chrome/Chromium (`--dump-dom`), verifying the connection-level behaviour against
the real Web Audio implementation. Set `CHROME_PATH` if Chrome is not at the
default location.

The `lifecycle` example (`npm run dev`, then open `#lifecycle`) is an
interactive version of the same checks and prints the live connection list.


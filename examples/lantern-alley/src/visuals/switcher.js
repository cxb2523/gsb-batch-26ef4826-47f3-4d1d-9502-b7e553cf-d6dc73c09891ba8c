import { createVisual, setVisualMode } from './registry.js';

// Swaps every visual in a running game between greybox and models.
// Only visuals are replaced; positions, states and timers stay as they are.
export function switchVisuals(game, mode) {
  setVisualMode(mode);
  for (const f of [game.hero, ...game.enemies]) {
    f.setVisual(createVisual(f.kind));
  }
  for (const p of game.props) {
    const v = createVisual(p.id);
    v.root.position.copy(p.visual.root.position);
    game.scene.remove(p.visual.root);
    p.visual.dispose();
    if (!p.broken) game.scene.add(v.root);   // a broken crate stays gone
    p.visual = v;
  }
  for (const f of game.pickups) {            // food dropped by crates matches too
    const v = createVisual('food');
    v.root.position.copy(f.visual.root.position);
    game.scene.remove(f.visual.root);
    f.visual.dispose();
    game.scene.add(v.root);
    f.visual = v;
  }
}

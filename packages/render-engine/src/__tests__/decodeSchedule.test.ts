import { describe, expect, it } from "vitest";
import type { Clip, ProjectDocument, Track } from "@cutaway/types";
import { staticValue } from "@cutaway/types";
import { createClip, createProject, createTrack } from "@cutaway/utils";
import { planVideoDecodeSchedule } from "../decodeSchedule";
import { resolveScene } from "../scene";

function videoContent(mediaId = "m1", speed = 1, sourceInFrame = 0) {
  return {
    kind: "video" as const,
    mediaId,
    sourceInFrame,
    speed,
    volume: staticValue(1),
    muted: false,
  };
}

function imageContent(mediaId = "img1") {
  return { kind: "image" as const, mediaId };
}

function projectWith(tracks: Track[], clips: Clip[]): ProjectDocument {
  const base = createProject();
  return {
    ...base,
    entities: {
      ...base.entities,
      tracks: Object.fromEntries(tracks.map((t) => [t.id, t])),
      clips: Object.fromEntries(clips.map((c) => [c.id, c])),
    },
    trackOrder: tracks.map((t) => t.id),
  };
}

/** One video clip starting at frame 0, `durationFrames` long. */
function singleVideoProject(durationFrames = 5, speed = 1): ProjectDocument {
  const track = createTrack({ kind: "video", index: 0 });
  const clip = createClip({
    trackId: track.id,
    startFrame: 0,
    durationFrames,
    content: videoContent("m1", speed),
  });
  return projectWith([track], [clip]);
}

describe("planVideoDecodeSchedule", () => {
  it("records one timestamp per frame a video is on screen", () => {
    const schedule = planVideoDecodeSchedule(singleVideoProject(5), 0, 5);

    expect([...schedule.keys()]).toEqual(["m1"]);
    expect(schedule.get("m1")).toHaveLength(5);
  });

  it("matches exactly what the render loop asks resolveScene for", () => {
    // The schedule is only useful if it mirrors the loop request-for-request;
    // this pins that contract rather than re-deriving the timing maths.
    const project = singleVideoProject(5);
    const expected: number[] = [];
    for (let frame = 0; frame < 5; frame += 1) {
      for (const node of resolveScene(project, frame).nodes) {
        if (node.content.kind === "media" && node.content.mediaKind === "video") {
          expected.push(node.content.sourceTimeSeconds);
        }
      }
    }

    expect(planVideoDecodeSchedule(project, 0, 5).get("m1")).toEqual(expected);
  });

  it("honours the export range rather than the whole timeline", () => {
    const schedule = planVideoDecodeSchedule(singleVideoProject(10), 4, 7);
    expect(schedule.get("m1")).toHaveLength(3);
  });

  it("returns timestamps in ascending order for a normal clip", () => {
    const times = planVideoDecodeSchedule(singleVideoProject(6), 0, 6).get("m1")!;
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("advances faster than realtime when the clip is sped up", () => {
    const normal = planVideoDecodeSchedule(singleVideoProject(4, 1), 0, 4).get("m1")!;
    const fast = planVideoDecodeSchedule(singleVideoProject(4, 2), 0, 4).get("m1")!;
    expect(fast[3]).toBeGreaterThan(normal[3]!);
  });

  it("ignores images — only video is decoded frame by frame", () => {
    const track = createTrack({ kind: "video", index: 0 });
    const clip = createClip({
      trackId: track.id,
      startFrame: 0,
      durationFrames: 3,
      content: imageContent("img1"),
    });

    expect(planVideoDecodeSchedule(projectWith([track], [clip]), 0, 3).size).toBe(0);
  });

  it("keeps one entry per clip when a media is used twice at once", () => {
    // Two clips of the same source overlapping means two decode requests per
    // frame; collapsing them would desynchronise the puller.
    const track = createTrack({ kind: "video", index: 0 });
    const other = createTrack({ kind: "video", index: 1 });
    const clips = [track, other].map((t) =>
      createClip({
        trackId: t.id,
        startFrame: 0,
        durationFrames: 3,
        content: videoContent("m1"),
      }),
    );

    expect(
      planVideoDecodeSchedule(projectWith([track, other], clips), 0, 3).get("m1"),
    ).toHaveLength(6);
  });

  it("tracks each media separately", () => {
    const track = createTrack({ kind: "video", index: 0 });
    const first = createClip({
      trackId: track.id,
      startFrame: 0,
      durationFrames: 2,
      content: videoContent("m1"),
    });
    const second = createClip({
      trackId: track.id,
      startFrame: 2,
      durationFrames: 3,
      content: videoContent("m2"),
    });
    const schedule = planVideoDecodeSchedule(projectWith([track], [first, second]), 0, 5);

    expect(schedule.get("m1")).toHaveLength(2);
    expect(schedule.get("m2")).toHaveLength(3);
  });

  it("never schedules a negative timestamp", () => {
    // A clip trimmed to start before its source begins would otherwise ask for
    // a time no decoder can produce.
    const track = createTrack({ kind: "video", index: 0 });
    const clip = createClip({
      trackId: track.id,
      startFrame: 0,
      durationFrames: 4,
      content: videoContent("m1", 1, -30),
    });
    const times = planVideoDecodeSchedule(projectWith([track], [clip]), 0, 4).get("m1")!;

    expect(times.every((t) => t >= 0)).toBe(true);
  });

  it("is empty for a range with no video", () => {
    expect(planVideoDecodeSchedule(createProject(), 0, 10).size).toBe(0);
  });
});

describe("planVideoDecodeSchedule — transition tails", () => {
  /** Two adjacent video clips at an exact cut, the second crossfading in. */
  function cutProject(transitionFrames: number): ProjectDocument {
    const track = createTrack({ kind: "video", index: 0 });
    const outgoing = createClip({
      id: "out",
      trackId: track.id,
      startFrame: 0,
      durationFrames: 10,
      content: videoContent("mA"),
    });
    const incoming: Clip = {
      ...createClip({
        id: "in",
        trackId: track.id,
        startFrame: 10,
        durationFrames: 10,
        content: videoContent("mB"),
      }),
      transitionIn: { kind: "crossfade", durationFrames: transitionFrames },
    };
    return projectWith([track], [outgoing, incoming]);
  }

  it("keeps scheduling the outgoing clip through its tail past its own end", () => {
    // Frames 10..14 are past the outgoing clip's end but still draw it.
    const times = planVideoDecodeSchedule(cutProject(4), 0, 14).get("mA")!;
    expect(times).toHaveLength(14);
    // The tail reads on past its source end, one frame at a time.
    expect(times[10]).toBeCloseTo(10 / 30);
    expect(times[13]).toBeCloseTo(13 / 30);
  });

  it("matches the render loop request-for-request across the tail", () => {
    const project = cutProject(4);
    // Re-derive exactly what the render loop will ask for, per media, in the
    // order it will ask — the contract the puller depends on.
    const expected = new Map<string, number[]>();
    for (let frame = 0; frame < 14; frame += 1) {
      for (const node of resolveScene(project, frame).nodes) {
        if (node.content.kind !== "media" || node.content.mediaKind !== "video") continue;
        const times = expected.get(node.content.mediaId) ?? [];
        times.push(Math.max(0, node.content.sourceTimeSeconds));
        expected.set(node.content.mediaId, times);
      }
    }

    const schedule = planVideoDecodeSchedule(project, 0, 14);
    // Same keys, and for each media the exact same ordered sequence of times.
    expect([...schedule.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [mediaId, times] of expected) {
      expect(schedule.get(mediaId)).toEqual(times);
    }

    // And per-media counts match the nodes drawn for that media: the outgoing
    // clip covers all 14 frames through its tail, the incoming only the last 4.
    expect(schedule.get("mA")).toHaveLength(14);
    expect(schedule.get("mB")).toHaveLength(4);
  });

  it("stops drawing the tail exactly at the end of the transition window", () => {
    // With a 4-frame window the tail spans frames 10..13; frame 14 is clear.
    const project = cutProject(4);
    const outNodes = (frame: number) =>
      resolveScene(project, frame).nodes.filter((n) => n.clipId === "out").length;

    expect(outNodes(13)).toBe(1);
    expect(outNodes(14)).toBe(0);
  });

  it("keeps per-request entries when a media is used by both sides of a cut", () => {
    // Same source on both clips: the tail frames add requests, they are not
    // deduplicated against the incoming clip's own.
    const track = createTrack({ kind: "video", index: 0 });
    const outgoing = createClip({
      id: "out",
      trackId: track.id,
      startFrame: 0,
      durationFrames: 10,
      content: videoContent("m1"),
    });
    const incoming: Clip = {
      ...createClip({
        id: "in",
        trackId: track.id,
        startFrame: 10,
        durationFrames: 10,
        content: videoContent("m1"),
      }),
      transitionIn: { kind: "crossfade", durationFrames: 4 },
    };
    const schedule = planVideoDecodeSchedule(projectWith([track], [outgoing, incoming]), 0, 14);

    // Frames 0..9: outgoing. 10..13: tail (out) + incoming head, two requests
    // each. So 10 + 4 + 4 = 18 entries, none collapsed.
    expect(schedule.get("m1")).toHaveLength(18);
  });

  it("still clamps a tail's negative source time to zero", () => {
    const track = createTrack({ kind: "video", index: 0 });
    // An in-point of -30 frames puts the whole clip (and its tail) before the
    // source begins; every scheduled time must still be clamped to ≥ 0.
    const outgoing = createClip({
      id: "out",
      trackId: track.id,
      startFrame: 0,
      durationFrames: 4,
      content: videoContent("m1", 1, -30),
    });
    const incoming: Clip = {
      ...createClip({
        id: "in",
        trackId: track.id,
        startFrame: 4,
        durationFrames: 4,
        content: videoContent("m2"),
      }),
      transitionIn: { kind: "crossfade", durationFrames: 3 },
    };
    const schedule = planVideoDecodeSchedule(projectWith([track], [outgoing, incoming]), 0, 7);

    // 4 body frames + 3 tail frames, all clamped.
    expect(schedule.get("m1")).toHaveLength(7);
    expect(schedule.get("m1")!.every((t) => t >= 0)).toBe(true);
  });
});

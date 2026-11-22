import { describe, expect, it } from "vitest";
import type {
  AudioContent,
  Clip,
  MediaAsset,
  ProjectDocument,
  Track,
  VideoContent,
} from "@cutaway/types";
import { staticValue } from "@cutaway/types";
import { createClip, createProject, createTrack } from "@cutaway/utils";
import { resolveAudioTimeline } from "../audio";
import { sourceTimeFor } from "../scene";

function audioContent(over: Partial<AudioContent> = {}): AudioContent {
  return {
    kind: "audio",
    mediaId: "a1",
    sourceInFrame: 0,
    speed: 1,
    volume: staticValue(1),
    muted: false,
    fadeInFrames: 0,
    fadeOutFrames: 0,
    ...over,
  };
}

function videoContent(over: Partial<VideoContent> = {}): VideoContent {
  return {
    kind: "video",
    mediaId: "v1",
    sourceInFrame: 0,
    speed: 1,
    volume: staticValue(1),
    muted: false,
    ...over,
  };
}

/** A minimal MediaAsset carrying only the audio-relevant metadata the resolver reads. */
function media(id: string, hasAudio: boolean): MediaAsset {
  return {
    id,
    metadata: { hasAudio },
  } as unknown as MediaAsset;
}

function projectWith(
  tracks: Track[],
  clips: Clip[],
  mediaAssets: MediaAsset[] = [],
): ProjectDocument {
  const base = createProject(); // 30 fps default
  return {
    ...base,
    entities: {
      ...base.entities,
      tracks: Object.fromEntries(tracks.map((t) => [t.id, t])),
      clips: Object.fromEntries(clips.map((c) => [c.id, c])),
      media: Object.fromEntries(mediaAssets.map((m) => [m.id, m])),
    },
    trackOrder: tracks.map((t) => t.id),
  };
}

const audioTrack = (over: Partial<Track> = {}): Track => ({
  ...createTrack({ id: "at", kind: "audio", index: 0 }),
  ...over,
});

const videoTrack = (over: Partial<Track> = {}): Track => ({
  ...createTrack({ id: "vt", kind: "video", index: 0 }),
  ...over,
});

describe("resolveAudioTimeline", () => {
  it("places a clip in output time and reads from its source in-point", () => {
    const track = audioTrack();
    const clip = createClip({
      id: "c1",
      trackId: track.id,
      startFrame: 30, // 1s at 30fps
      durationFrames: 60, // 2s
      content: audioContent({ sourceInFrame: 15 }), // 0.5s into the source
    });

    const [resolved] = resolveAudioTimeline(projectWith([track], [clip]), 0, 300);

    expect(resolved).toMatchObject({
      mediaId: "a1",
      startSeconds: 1,
      durationSeconds: 2,
      sourceInSeconds: 0.5,
      gain: 1,
    });
  });

  it("multiplies clip volume by track volume for gain", () => {
    const track = audioTrack({ volume: 0.5 });
    const clip = createClip({
      id: "c1",
      trackId: track.id,
      startFrame: 0,
      durationFrames: 30,
      content: audioContent({ volume: staticValue(0.6) }),
    });

    expect(resolveAudioTimeline(projectWith([track], [clip]), 0, 300)[0]!.gain).toBeCloseTo(0.3);
  });

  it("clips the head and advances the source when exporting a sub-range", () => {
    const track = audioTrack();
    const clip = createClip({
      id: "c1",
      trackId: track.id,
      startFrame: 0,
      durationFrames: 120, // 4s
      content: audioContent({ sourceInFrame: 0, speed: 1 }),
    });

    // Export starts at frame 30 (1s) — the first second of the clip is skipped.
    const resolved = resolveAudioTimeline(projectWith([track], [clip]), 30, 90)[0]!;
    expect(resolved.startSeconds).toBe(0); // starts at the export's beginning
    expect(resolved.sourceInSeconds).toBe(1); // 1s already consumed
    expect(resolved.durationSeconds).toBe(2); // frames 30..90 → 2s
  });

  it("advances the source faster than real time when sped up", () => {
    const track = audioTrack();
    const clip = createClip({
      id: "c1",
      trackId: track.id,
      startFrame: 0,
      durationFrames: 120,
      content: audioContent({ sourceInFrame: 0, speed: 2 }),
    });

    // Skipping 30 output frames at 2× consumes 60 source frames = 2s.
    expect(resolveAudioTimeline(projectWith([track], [clip]), 30, 90)[0]!.sourceInSeconds).toBe(2);
  });

  it("excludes muted clips, muted tracks, and hidden clips", () => {
    const track = audioTrack();
    const base = { trackId: track.id, startFrame: 0, durationFrames: 30 };
    const clips = [
      createClip({ id: "muted-clip", ...base, content: audioContent({ muted: true }) }),
      { ...createClip({ id: "hidden", ...base, content: audioContent() }), hidden: true },
    ];
    expect(resolveAudioTimeline(projectWith([track], clips), 0, 300)).toHaveLength(0);

    const mutedTrack = audioTrack({ muted: true });
    const onMuted = createClip({
      ...base,
      id: "c",
      trackId: mutedTrack.id,
      content: audioContent(),
    });
    expect(resolveAudioTimeline(projectWith([mutedTrack], [onMuted]), 0, 300)).toHaveLength(0);
  });

  it("silences non-soloed tracks when any audio track is soloed", () => {
    const soloed = audioTrack({ id: "solo", index: 0, solo: true });
    const other = audioTrack({ id: "other", index: 1 });
    const base = { startFrame: 0, durationFrames: 30 };
    const clips = [
      createClip({ id: "on-solo", trackId: soloed.id, ...base, content: audioContent() }),
      createClip({ id: "on-other", trackId: other.id, ...base, content: audioContent() }),
    ];

    const resolved = resolveAudioTimeline(projectWith([soloed, other], clips), 0, 300);
    expect(resolved.map((r) => r.clipId)).toEqual(["on-solo"]);
  });

  it("ignores clips entirely outside the export range", () => {
    const track = audioTrack();
    const clip = createClip({
      id: "c1",
      trackId: track.id,
      startFrame: 200,
      durationFrames: 30,
      content: audioContent(),
    });
    expect(resolveAudioTimeline(projectWith([track], [clip]), 0, 100)).toHaveLength(0);
  });

  it("carries fade durations through in seconds", () => {
    const track = audioTrack();
    const clip = createClip({
      id: "c1",
      trackId: track.id,
      startFrame: 0,
      durationFrames: 60,
      content: audioContent({ fadeInFrames: 15, fadeOutFrames: 30 }),
    });
    const resolved = resolveAudioTimeline(projectWith([track], [clip]), 0, 300)[0]!;
    expect(resolved.fadeInSeconds).toBe(0.5);
    expect(resolved.fadeOutSeconds).toBe(1);
  });
});

describe("resolveAudioTimeline — video clips", () => {
  it("includes a video clip's embedded audio when the media has an audio stream", () => {
    const track = videoTrack();
    const clip = createClip({
      id: "v",
      trackId: track.id,
      startFrame: 30,
      durationFrames: 60,
      content: videoContent({ mediaId: "v1", volume: staticValue(0.8) }),
    });

    const [resolved] = resolveAudioTimeline(
      projectWith([track], [clip], [media("v1", true)]),
      0,
      300,
    );
    expect(resolved).toMatchObject({
      mediaId: "v1",
      startSeconds: 1,
      durationSeconds: 2,
      gain: 0.8,
    });
  });

  it("excludes a silent video (media without an audio stream)", () => {
    const track = videoTrack();
    const clip = createClip({
      id: "v",
      trackId: track.id,
      startFrame: 0,
      durationFrames: 30,
      content: videoContent({ mediaId: "v1" }),
    });
    expect(
      resolveAudioTimeline(projectWith([track], [clip], [media("v1", false)]), 0, 300),
    ).toHaveLength(0);
  });

  it("excludes a video clip whose own audio is muted, or whose track is muted", () => {
    const track = videoTrack();
    const mutedClip = createClip({
      id: "v1c",
      trackId: track.id,
      startFrame: 0,
      durationFrames: 30,
      content: videoContent({ mediaId: "v1", muted: true }),
    });
    expect(
      resolveAudioTimeline(projectWith([track], [mutedClip], [media("v1", true)]), 0, 300),
    ).toHaveLength(0);

    const mutedTrack = videoTrack({ muted: true });
    const clip = createClip({
      id: "v2c",
      trackId: mutedTrack.id,
      startFrame: 0,
      durationFrames: 30,
      content: videoContent({ mediaId: "v1" }),
    });
    expect(
      resolveAudioTimeline(projectWith([mutedTrack], [clip], [media("v1", true)]), 0, 300),
    ).toHaveLength(0);
  });

  it("silences video-clip audio when an audio track is soloed", () => {
    const vTrack = videoTrack({ id: "vt", index: 0 });
    const aTrack = audioTrack({ id: "at", index: 1, solo: true });
    const vClip = createClip({
      id: "v",
      trackId: vTrack.id,
      startFrame: 0,
      durationFrames: 30,
      content: videoContent({ mediaId: "v1" }),
    });
    const aClip = createClip({
      id: "a",
      trackId: aTrack.id,
      startFrame: 0,
      durationFrames: 30,
      content: audioContent(),
    });

    const resolved = resolveAudioTimeline(
      projectWith([vTrack, aTrack], [vClip, aClip], [media("v1", true)]),
      0,
      300,
    );
    expect(resolved.map((r) => r.clipId)).toEqual(["a"]);
  });

  it("mixes audio-track and video-track audio together when both are audible", () => {
    const vTrack = videoTrack({ id: "vt", index: 0 });
    const aTrack = audioTrack({ id: "at", index: 1 });
    const vClip = createClip({
      id: "v",
      trackId: vTrack.id,
      startFrame: 0,
      durationFrames: 30,
      content: videoContent({ mediaId: "v1" }),
    });
    const aClip = createClip({
      id: "a",
      trackId: aTrack.id,
      startFrame: 0,
      durationFrames: 30,
      content: audioContent(),
    });

    const resolved = resolveAudioTimeline(
      projectWith([vTrack, aTrack], [vClip, aClip], [media("v1", true)]),
      0,
      300,
    );
    expect(resolved.map((r) => r.clipId).sort()).toEqual(["a", "v"]);
  });
});

describe("resolveAudioTimeline — transition tails", () => {
  /** Two adjacent video clips at an exact cut, the second transitioning in. */
  function cutProject(
    transition: Clip["transitionIn"],
    over: { sourceInFrame?: number; speed?: number } = {},
  ): ProjectDocument {
    const track = videoTrack();
    const outgoing = createClip({
      id: "out",
      trackId: track.id,
      startFrame: 0,
      durationFrames: 60, // ends at 2s
      content: videoContent({
        mediaId: "v1",
        sourceInFrame: over.sourceInFrame ?? 0,
        speed: over.speed ?? 1,
      }),
    });
    const incoming: Clip = {
      ...createClip({
        id: "in",
        trackId: track.id,
        startFrame: 60,
        durationFrames: 60,
        content: videoContent({ mediaId: "v2" }),
      }),
      transitionIn: transition,
    };
    return projectWith([track], [outgoing, incoming], [media("v1", true), media("v2", true)]);
  }

  it("keeps the outgoing clip's audio sounding through the transition window", () => {
    const resolved = resolveAudioTimeline(
      cutProject({ kind: "crossfade", durationFrames: 20 }),
      0,
      300,
    );
    const outgoing = resolved.find((r) => r.clipId === "out")!;

    // Its own 60 frames plus the 20-frame window the incoming clip pulls it through.
    expect(outgoing.startSeconds).toBe(0);
    expect(outgoing.durationSeconds).toBeCloseTo(80 / 30);
    expect(outgoing.sourceInSeconds).toBe(0);
  });

  it("does the same for a dip, whose window is identical in length", () => {
    const resolved = resolveAudioTimeline(cutProject({ kind: "dip", durationFrames: 20 }), 0, 300);
    expect(resolved.find((r) => r.clipId === "out")!.durationSeconds).toBeCloseTo(80 / 30);
  });

  it("does not extend an audio clip when there is no transition", () => {
    const resolved = resolveAudioTimeline(cutProject(null), 0, 300);
    expect(resolved.find((r) => r.clipId === "out")!.durationSeconds).toBeCloseTo(60 / 30);
  });

  it("does not extend across a gap rather than an exact cut", () => {
    const track = videoTrack();
    const outgoing = createClip({
      id: "out",
      trackId: track.id,
      startFrame: 0,
      durationFrames: 60,
      content: videoContent({ mediaId: "v1" }),
    });
    const incoming: Clip = {
      ...createClip({
        id: "in",
        trackId: track.id,
        startFrame: 70, // 10-frame gap: not a cut
        durationFrames: 60,
        content: videoContent({ mediaId: "v2" }),
      }),
      transitionIn: { kind: "crossfade", durationFrames: 20 },
    };
    const project = projectWith(
      [track],
      [outgoing, incoming],
      [media("v1", true), media("v2", true)],
    );

    expect(
      resolveAudioTimeline(project, 0, 300).find((r) => r.clipId === "out")!.durationSeconds,
    ).toBeCloseTo(60 / 30);
  });

  it("advances the source in-point as the export starts deeper into the window", () => {
    // Export begins at frame 70: 10 frames past the outgoing clip's own end,
    // i.e. halfway through the tail. Its audio must pick up exactly there.
    const resolved = resolveAudioTimeline(
      cutProject({ kind: "crossfade", durationFrames: 20 }),
      70,
      300,
    );
    const outgoing = resolved.find((r) => r.clipId === "out")!;

    expect(outgoing.startSeconds).toBe(0);
    expect(outgoing.sourceInSeconds).toBeCloseTo(70 / 30); // 2s body + 10 tail frames
    expect(outgoing.durationSeconds).toBeCloseTo(10 / 30); // the remaining half of the tail
  });

  it("scales the tail's source consumption by the clip's speed", () => {
    const resolved = resolveAudioTimeline(
      cutProject({ kind: "crossfade", durationFrames: 20 }, { speed: 2 }),
      70,
      300,
    );
    const outgoing = resolved.find((r) => r.clipId === "out")!;
    // 70 frames skipped at 2× consume 140 source frames = 2·70/30 seconds.
    expect(outgoing.sourceInSeconds).toBeCloseTo((70 * 2) / 30);
    // Output duration stays in timeline frames regardless of speed.
    expect(outgoing.durationSeconds).toBeCloseTo(10 / 30);
  });

  it("leaves a clip whose transition is only brought by a different track alone", () => {
    // A transition on another track must not reach across this track's cut.
    const vTrack = videoTrack({ id: "vt", index: 0 });
    const other = videoTrack({ id: "vt2", index: 1 });
    const outgoing = createClip({
      id: "out",
      trackId: vTrack.id,
      startFrame: 0,
      durationFrames: 60,
      content: videoContent({ mediaId: "v1" }),
    });
    const incomingOther: Clip = {
      ...createClip({
        id: "in2",
        trackId: other.id,
        startFrame: 60,
        durationFrames: 60,
        content: videoContent({ mediaId: "v2" }),
      }),
      transitionIn: { kind: "crossfade", durationFrames: 20 },
    };
    const project = projectWith(
      [vTrack, other],
      [outgoing, incomingOther],
      [media("v1", true), media("v2", true)],
    );

    expect(
      resolveAudioTimeline(project, 0, 300).find((r) => r.clipId === "out")!.durationSeconds,
    ).toBeCloseTo(60 / 30);
  });

  it("extends an audio-track clip the same way, keeping fade rules intact", () => {
    const track = audioTrack();
    const outgoing = createClip({
      id: "out",
      trackId: track.id,
      startFrame: 0,
      durationFrames: 60,
      content: audioContent({ fadeOutFrames: 15 }),
    });
    const incoming: Clip = {
      ...createClip({
        id: "in",
        trackId: track.id,
        startFrame: 60,
        durationFrames: 60,
        content: audioContent({ mediaId: "a2" }),
      }),
      transitionIn: { kind: "crossfade", durationFrames: 20 },
    };
    const project = projectWith([track], [outgoing, incoming]);

    const resolved = resolveAudioTimeline(project, 0, 300).find((r) => r.clipId === "out")!;
    expect(resolved.durationSeconds).toBeCloseTo(80 / 30);
    // The authored fade-out still travels through unchanged, in seconds.
    expect(resolved.fadeOutSeconds).toBe(0.5);
  });

  it("still excludes muted and hidden clips even when they own a tail", () => {
    const project = cutProject({ kind: "crossfade", durationFrames: 20 });
    const clips = project.entities.clips as Record<string, Clip>;
    clips.out = {
      ...clips.out!,
      content: { ...(clips.out!.content as VideoContent), muted: true },
    };

    expect(resolveAudioTimeline(project, 0, 300).map((r) => r.clipId)).toEqual(["in"]);
  });

  it("places the outgoing sound at the same source time the picture shows in the tail", () => {
    // A video clip on a video track carries both picture and embedded audio. For
    // every frame of the tail, the audio the mixer will read from source must be
    // exactly the source time the renderer draws — that is what "in sync" means.
    const track = videoTrack();
    const outgoing = createClip({
      id: "out",
      trackId: track.id,
      startFrame: 0,
      durationFrames: 60,
      content: videoContent({ mediaId: "v1", sourceInFrame: 15, speed: 1 }),
    });
    const incoming: Clip = {
      ...createClip({
        id: "in",
        trackId: track.id,
        startFrame: 60,
        durationFrames: 60,
        content: videoContent({ mediaId: "v1" }),
      }),
      transitionIn: { kind: "crossfade", durationFrames: 20 },
    };
    const project = projectWith([track], [outgoing, incoming], [media("v1", true)]);

    const [placed] = resolveAudioTimeline(project, 0, 300).filter((r) => r.clipId === "out");
    expect(placed).toBeDefined();

    // The tail runs frames 60..79; the placement is one continuous read whose
    // source offset at frame f is `sourceInSeconds + (f - startFrameOfClip) *
    // speed / fps`. Verify a handful of tail frames against `sourceTimeFor`,
    // the exact function the renderer uses to pick its source frame.
    for (const frame of [60, 65, 70, 79]) {
      const atSource = placed!.sourceInSeconds + ((frame - 0) * placed!.speed) / 30;
      const picture = sourceTimeFor(outgoing, frame, 15, 1, 30);
      expect(atSource).toBeCloseTo(picture);
    }
  });
});

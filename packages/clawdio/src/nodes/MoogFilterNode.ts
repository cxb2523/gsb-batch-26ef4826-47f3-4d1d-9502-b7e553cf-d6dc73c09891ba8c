import MoogWorklet from "@/workers/moog.ts?worker&url";
import "clawdio-moog/clawdio_moog_bg.wasm?no-inline";
import MoogWasmPath from "clawdio-moog/clawdio_moog_bg.wasm?url&no-inline";
import type { MoogEventSetCutoff, MoogEventSetResonance } from "@/workers/moog";
import { CustomAudioWorkletNode } from "./types";
import { assertNode, createWorkletNode } from "./utils";

export type MoogNode = CustomAudioWorkletNode & {
  setResonance: (resonance: number) => void;
  setCutoff: (cutoff: number) => void;
};

/**
 * Creates a Moog audio worklet node and initializes it's WASM module.
 * Returns the AudioWorkletNode and helpful setter functions for parameters
 * @returns MoogNode
 */
const createMoogNode = async (
  audioCtx: AudioContext,
  cutoff = 0.065,
  resonance = 3.5
) => {
  let nodeRef: AudioWorkletNode | null = null;

  // Setter functions to communicate with worklet params. These always post a
  // message to the worklet's MessagePort so the parameter update reaches the
  // WASM module it owns. Never mutate the worklet state directly.
  const setResonance = (newResonance: number) => {
    if (!nodeRef) return;
    const message: MoogEventSetResonance = {
      type: "set-resonance",
      data: newResonance,
    };
    nodeRef.port.postMessage(message);
  };

  const setCutoff = (newCutoff: number) => {
    if (!nodeRef) return;
    const message: MoogEventSetCutoff = {
      type: "set-cutoff",
      data: newCutoff,
    };
    nodeRef.port.postMessage(message);
  };

  // Create the node and return it
  nodeRef = await createWorkletNode(
    audioCtx,
    MoogWasmPath,
    MoogWorklet,
    "clawdio-moog",
    {
      resonance,
      cutoff,
    }
  );

  assertNode(nodeRef, "Moog");

  return {
    node: nodeRef,
    setResonance,
    setCutoff,
  } as MoogNode;
};

export default createMoogNode;

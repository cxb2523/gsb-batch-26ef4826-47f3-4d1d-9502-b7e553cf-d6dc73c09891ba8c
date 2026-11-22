import BitcrusherWorklet from "@/workers/bitcrusher.ts?worker&url";
import "clawdio-bitcrusher/clawdio_bitcrusher_bg.wasm?no-inline";
import BitcrusherWasmPath from "clawdio-bitcrusher/clawdio_bitcrusher_bg.wasm?url&no-inline";
import type {
  BitcrusherEventSetBits,
  BitcrusherEventSetNormfreq,
} from "@/workers/bitcrusher";
import { CustomAudioWorkletNode } from "./types";
import { assertNode, createWorkletNode } from "./utils";

export type BitcrusherNode = CustomAudioWorkletNode & {
  setBits: (newBits: number) => void;
  setNormfreq: (newFreq: number) => void;
};

/**
 * Creates a Bitcrusher audio worklet node and initializes it's WASM module.
 * Returns the AudioWorkletNode and helpful setter functions for parameters
 * @returns BitcrusherNode
 */
const createBitcrusherNode = async (
  audioCtx: AudioContext,
  bits = 4,
  normfreq = 0.1
) => {
  let nodeRef: AudioWorkletNode | null = null;

  // Setter functions to communicate with worklet params. These always post a
  // message to the worklet's MessagePort so the parameter update reaches the
  // WASM module it owns. Never mutate the worklet state directly.
  const setBits = (newBits: number) => {
    if (!nodeRef) return;
    const message: BitcrusherEventSetBits = {
      type: "set-bits",
      data: newBits,
    };
    nodeRef.port.postMessage(message);
  };

  const setNormfreq = (newFreq: number) => {
    if (!nodeRef) return;
    const message: BitcrusherEventSetNormfreq = {
      type: "set-normfreq",
      data: newFreq,
    };
    nodeRef.port.postMessage(message);
  };

  // Create the node and return it
  nodeRef = await createWorkletNode(
    audioCtx,
    BitcrusherWasmPath,
    BitcrusherWorklet,
    "clawdio-bitcrusher",
    {
      bits,
      normfreq,
    }
  );

  assertNode(nodeRef, "Bitcrusher");

  return {
    node: nodeRef,
    setBits,
    setNormfreq,
  } as BitcrusherNode;
};

export default createBitcrusherNode;

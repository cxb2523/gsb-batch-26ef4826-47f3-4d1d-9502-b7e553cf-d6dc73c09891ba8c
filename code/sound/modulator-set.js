// Microtonal Fabric
//
// Copyright (c) Sergey A Kryukov, 2017-2021
//
// http://www.SAKryukov.org
// http://www.codeproject.com/Members/SAKryukov
// https://github.com/SAKryukov
// https://github.com/SAKryukov/microtonal-fabric

class ModulatorSet {

    #implementation = { isFmEnabled: true, isAmEnabled: true };

    constructor(audioContext, soundSourceFrequency) {
        if (audioContext)
            this.context = audioContext;
        this.#implementation.soundSourceFrequency == soundSourceFrequency; // undefined for absolute-frequency modulator
        this.#implementation.frequencyModulatorList = [];
        this.#implementation.amplitudeModulatorList = [];
        this.#implementation.frequencyModulationTargets = new Set();
        this.#implementation.amplitudeModulationTargets = new Set();
        this.#implementation.releaseModulators = modulatorList => {
            for (let modulator of modulatorList) {
                modulator.disconnect();
                modulator.deactivate();
            } //loop
            modulatorList.splice(0);
        }; //this.#implementation.releaseModulators
        this.#implementation.populate = (modulatorList, masterDepthMode, modulationData) => {
            if (masterDepthMode)
                masterDepthMode.gain.value = modulationData.masterDepth;
            this.#implementation.releaseModulators(modulatorList);
            for (let dataElement of modulationData.modes) {
                let frequency = dataElement.frequency;
                if (soundSourceFrequency)
                    frequency *= soundSourceFrequency;
                const modulator = new Modulator(this.context);
                modulator.depth = dataElement.depth;
                modulator.frequency = dataElement.frequency;
                if (masterDepthMode)
                    modulator.connect(masterDepthMode); // each modulator is connected exactly once
                modulatorList.push(modulator);
            } //loop
        } //this.#implementation.populate
        this.#implementation.baseDeactivate = _ => {
            this.#implementation.releaseModulators(this.#implementation.frequencyModulatorList);
            this.#implementation.releaseModulators(this.#implementation.amplitudeModulatorList);
            if (this.#implementation.frequencyModulatatioMasterDepth)
                this.#implementation.frequencyModulatatioMasterDepth.disconnect();
            if (this.#implementation.amplitudeModulatatioMasterDepth)
                this.#implementation.amplitudeModulatatioMasterDepth.disconnect();
            this.#implementation.frequencyModulationTargets.clear();
            this.#implementation.amplitudeModulationTargets.clear();
        }; //baseDeactivate
    } //constructor

    // interface:

    set frequencyModulationData(dataset) {
        this.#implementation.populate(this.#implementation.frequencyModulatorList, this.#implementation.frequencyModulatatioMasterDepth, dataset);
    } //set frequencyModulationData
    set amplitudeModulationData(dataset) {
        this.#implementation.populate(this.#implementation.amplitudeModulatorList, this.#implementation.amplitudeModulatatioMasterDepth, dataset);
    } //set amplitudeModulationData

    connectToAudioParameters(frequencyAudioParameter, amplitudeAudioParameter) {
        this.#implementation.frequencyAudioParameter = frequencyAudioParameter;
        this.#implementation.amplitudeAudioParameter = amplitudeAudioParameter;
        const connectTo = (list, masterDepthMode, audioParameter, targets) => {
            if (targets.has(audioParameter)) return; // keep exactly one connection from master depth to each target
            targets.add(audioParameter);
            masterDepthMode.connect(audioParameter);
        } //connectTo
        if (frequencyAudioParameter) {
            if (!this.#implementation.frequencyModulatatioMasterDepth) {
                this.#implementation.frequencyModulatatioMasterDepth = new GainNode(this.context, { gain: 1 });
                for (let modulator of this.#implementation.frequencyModulatorList)
                    modulator.connect(this.#implementation.frequencyModulatatioMasterDepth);
            } //if
            connectTo(this.#implementation.frequencyModulatorList, this.#implementation.frequencyModulatatioMasterDepth, frequencyAudioParameter, this.#implementation.frequencyModulationTargets);
        } //if
        if (amplitudeAudioParameter) {
            if (!this.#implementation.amplitudeModulatatioMasterDepth) {
                this.#implementation.amplitudeModulatatioMasterDepth = new GainNode(this.context, { gain: 1 });
                for (let modulator of this.#implementation.amplitudeModulatorList)
                    modulator.connect(this.#implementation.amplitudeModulatatioMasterDepth);
            } //if
            connectTo(this.#implementation.amplitudeModulatorList, this.#implementation.amplitudeModulatatioMasterDepth, amplitudeAudioParameter, this.#implementation.amplitudeModulationTargets);
        } //if
    } //connectToAudioParameters

    set frequencyModulationEnable(enable) {
        if (!enable || !this.#implementation.preservedFmMasterGain)
            this.#implementation.preservedFmMasterGain = this.#implementation.frequencyModulatatioMasterDepth.gain.value;
        this.#implementation.frequencyModulatatioMasterDepth.gain.value = enable ? this.#implementation.preservedFmMasterGain : 0;
    } //set frequencyModulationEnable
    get frequencyModulationEnable() { return this.#implementation.isFmEnabled; }

    set amplitudeModulationEnable(enable) {
        if (!enable || !this.#implementation.preservedAmMasterGain)
            this.#implementation.preservedAmMasterGain = this.#implementation.amplitudeModulatatioMasterDepth.gain.value;
        this.#implementation.amplitudeModulatatioMasterDepth.gain.value = enable ? this.#implementation.preservedAmMasterGain : 0;
    } //set amplitudeModulationEnable
    get amplitudeModulationEnable() { return this.#implementation.isAmEnabled; }

    baseDeactivate() { this.#implementation.baseDeactivate(); }

} //class ModulatorSet

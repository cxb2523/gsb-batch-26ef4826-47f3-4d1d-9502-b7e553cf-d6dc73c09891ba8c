// Microtonal Fabric
//
// Copyright (c) Sergey A Kryukov, 2017-2021
//
// http://www.SAKryukov.org
// http://www.codeproject.com/Members/SAKryukov
// https://github.com/SAKryukov
// https://github.com/SAKryukov/microtonal-fabric

class ChainNode {

    #implementation = { collection: [], upstream: undefined, target: undefined, isEnabled: true };

    constructor(upstream, target) {
        this.#implementation.upstream = upstream;
        this.#implementation.target = target;
        // (Re)establishes exactly one path from upstream to target:
        // through the chain, if it is enabled and not empty, directly otherwise.
        // All stale connections are removed first, so no path can break or stack up.
        this.#implementation.connect = () => {
            const collection = this.#implementation.collection;
            this.#implementation.upstream.disconnect();
            for (let node of collection)
                node.disconnect();
            for (let index = 0; index < collection.length - 1; ++index)
                collection[index].connect(collection[index + 1]);
            if (this.#implementation.isEnabled && collection.length > 0) {
                this.#implementation.upstream.connect(collection[0]);
                collection[collection.length - 1].connect(this.#implementation.target);
            } else
                this.#implementation.upstream.connect(this.#implementation.target);
        }; //this.#implementation.connect
        this.#implementation.setEnabled = doEnable => {
            this.#implementation.isEnabled = !!doEnable;
            this.#implementation.connect();
        }; //this.#implementation.setEnabled
        this.#implementation.deactivate = _ => {
            for (let node of this.#implementation.collection)
                node.disconnect();
        }; //this.#implementation.deactivate

    } //constructor

    populate(nodeList) {
        for (let node of this.#implementation.collection)
            node.disconnect();
        this.#implementation.collection.splice(0);
        for (let node of nodeList)
            this.#implementation.collection.push(node);
        this.#implementation.connect();
    } //populate

    get isEnabled() { return this.#implementation.isEnabled; }
    set isEnabled(value) { this.#implementation.setEnabled(value); }

    deactivate() { this.#implementation.deactivate(); }

} //class ChainNode

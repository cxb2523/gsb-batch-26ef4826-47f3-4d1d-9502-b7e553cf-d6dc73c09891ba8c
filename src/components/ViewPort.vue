<template>
  <div class="viewport"></div>
</template>

<script>
import { useThreeStore } from "@/store";

export default {
  data() {
    return {
      height: 0,
    };
  },
  mounted() {
    const store = useThreeStore();

    // The store owns the render loop, controls change listener and window
    // resize listener; the view only tells it when to start and stop.
    store.init({
      width: this.$el.offsetWidth,
      height: this.$el.offsetHeight,
      el: this.$el,
    });
  },
  beforeUnmount() {
    const store = useThreeStore();

    // Cancel the queued animation frame, detach listeners and release
    // renderer/controls resources so leaving the view leaves nothing behind.
    store.dispose();
  },
};
</script>

<style>
.viewport {
  height: 100%;
  width: 100%;
}
</style>

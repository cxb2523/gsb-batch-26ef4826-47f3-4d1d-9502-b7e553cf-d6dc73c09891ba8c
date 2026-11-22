import { defineStore } from 'pinia'
import { markRaw } from 'vue'
import {
  Scene,
  PerspectiveCamera,
  WebGLRenderer,
  Color,
  FogExp2,
  CylinderGeometry,
  MeshPhongMaterial,
  Mesh,
  DirectionalLight,
  AmbientLight,
  LineBasicMaterial,
  BufferGeometry,
  Vector3,
  Line
} from 'three'
import { TrackballControls } from 'three/addons/controls/TrackballControls.js'

export const useThreeStore = defineStore('three', {
  state: () => ({
    width: 0,
    height: 0,

    // --- Three.js objects (non-reactive) ---
    camera: null,
    controls: null,
    scene: null,
    renderer: null,
    container: null,
    axisLines: [],
    pyramids: [],

    // --- Render loop / listener bookkeeping ---
    animationFrameId: null,

    // --- UI-facing state: the single source of truth for visibility ---
    pyramidsVisible: true,
    axisLinesVisible: true,

    cameraPosition: { x: 0, y: 0, z: 0 }
  }),

  getters: {
  },

  actions: {
    setViewportSize({ width, height }) {
      this.width = width
      this.height = height
    },

    initializeRenderer(el) {
      this.renderer = markRaw(new WebGLRenderer({ antialias: true }))
      this.renderer.setPixelRatio(window.devicePixelRatio)
      this.renderer.setSize(this.width, this.height)
      el.appendChild(this.renderer.domElement)
    },

    initializeCamera() {
      this.camera = markRaw(new PerspectiveCamera(
        // 1. Field of View (degrees)
        60,
        // 2. Aspect ratio
        this.width / this.height,
        // 3. Near clipping plane
        1,
        // 4. Far clipping plane
        1000
      ))
      this.camera.position.z = 500
      this.cameraPosition = { x: 0, y: 0, z: 500 }
    },

    initializeControls() {
      this.controls = markRaw(new TrackballControls(
        this.camera,
        this.renderer.domElement
      ))
      this.controls.rotateSpeed = 1.0
      this.controls.zoomSpeed = 1.2
      this.controls.panSpeed = 0.8
      this.controls.noZoom = false
      this.controls.noPan = false
      this.controls.staticMoving = true
      this.controls.dynamicDampingFactor = 0.3
      this.controls.keys = [65, 83, 68]
    },

    /**
     * Re-render whenever the controls report a change. Bound once per init
     * and removed on dispose so repeated init never stacks listeners.
     */
    onControlsChange() {
      this.renderer.render(this.scene, this.camera)
    },

    /**
     * Keep camera aspect ratio, renderer size and the controls' screen
     * metrics in sync with the container. Bound once per init.
     */
    onWindowResize() {
      if (!this.container || !this.renderer || !this.camera || !this.controls) {
        return
      }
      this.resize({
        width: this.container.offsetWidth,
        height: this.container.offsetHeight
      })
    },

    updateControls() {
      if (this.controls) {
        this.controls.update()
      }
    },

    initializeScene() {
      this.scene = markRaw(new Scene())
      this.scene.background = new Color(0xcccccc)
      this.scene.fog = new FogExp2(0xcccccc, 0.002)

      // Fresh arrays on every (re)init so stale objects never accumulate.
      this.pyramids = []
      this.axisLines = []

      var geometry = markRaw(new CylinderGeometry(0, 10, 30, 4, 1))
      var material = markRaw(new MeshPhongMaterial({
        color: 0xffffff,
        flatShading: true
      }))

      for (var i = 0; i < 500; i++) {
        var mesh = markRaw(new Mesh(geometry, material))
        mesh.position.x = (Math.random() - 0.5) * 1000
        mesh.position.y = (Math.random() - 0.5) * 1000
        mesh.position.z = (Math.random() - 0.5) * 1000
        mesh.updateMatrix()
        mesh.matrixAutoUpdate = false
        this.pyramids.push(mesh)
      }
      // Reconcile with the visibility flags: the scene must always match
      // the store's visible flags, even after a re-initialization.
      if (this.pyramidsVisible) {
        this.scene.add(...this.pyramids)
      }

      // lights
      var lightA = markRaw(new DirectionalLight(0xffffff))
      lightA.position.set(1, 1, 1)
      this.scene.add(lightA)

      var lightB = markRaw(new DirectionalLight(0x002288))
      lightB.position.set(-1, -1, -1)
      this.scene.add(lightB)

      var lightC = markRaw(new AmbientLight(0x222222))
      this.scene.add(lightC)

      // Axis Line 1 (Y-axis - Blue)
      var materialB = markRaw(new LineBasicMaterial({ color: 0x0000ff }))
      var geometryB = markRaw(new BufferGeometry())
      const pointsB = [
        new Vector3(0, 0, 0),
        new Vector3(0, 1000, 0)
      ]
      geometryB.setFromPoints(pointsB)
      var lineA = markRaw(new Line(geometryB, materialB))
      this.axisLines.push(lineA)

      // Axis Line 2 (X-axis - Green)
      var materialC = markRaw(new LineBasicMaterial({ color: 0x00ff00 }))
      var geometryC = markRaw(new BufferGeometry())
      const pointsC = [
        new Vector3(0, 0, 0),
        new Vector3(1000, 0, 0)
      ]
      geometryC.setFromPoints(pointsC)
      var lineB = markRaw(new Line(geometryC, materialC))
      this.axisLines.push(lineB)

      // Axis Line 3 (Z-axis - Red)
      var materialD = markRaw(new LineBasicMaterial({ color: 0xff0000 }))
      var geometryD = markRaw(new BufferGeometry())
      const pointsD = [
        new Vector3(0, 0, 0),
        new Vector3(0, 0, 1000)
      ]
      geometryD.setFromPoints(pointsD)
      var lineC = markRaw(new Line(geometryD, materialD))
      this.axisLines.push(lineC)

      if (this.axisLinesVisible) {
        this.scene.add(...this.axisLines)
      }
    },

    resize({ width, height }) {
      if (!this.camera || !this.renderer || !this.controls) {
        return
      }
      this.width = width
      this.height = height
      this.camera.aspect = width / height
      this.camera.updateProjectionMatrix()
      this.renderer.setSize(width, height)
      this.controls.handleResize()
      this.controls.update()
      this.renderer.render(this.scene, this.camera)
    },

    setCameraPosition({ x, y, z }) {
      if (this.camera) {
        this.camera.position.set(x, y, z)
        this.cameraPosition = { x, y, z }
      }
    },

    /**
     * Reset the camera to its initial pose. Position, rotation, up vector
     * and the controls' target are all written first; the controls are then
     * synchronized and the scene redrawn. Without this synchronization the
     * controls keep stale internal state and the first drag snaps the view
     * back to the old orientation.
     */
    resetCamera() {
      if (!this.camera || !this.controls) {
        return
      }

      this.camera.position.set(0, 0, 500)
      this.camera.rotation.set(0, 0, 0)
      this.camera.quaternion.set(0, 0, 0, 1)
      this.camera.up.set(0, 1, 0)
      this.controls.target.set(0, 0, 0)

      // Synchronize internal controls state with the new camera pose,
      // then force an immediate repaint so the next drag starts from here.
      this.controls.update()
      this.renderer.render(this.scene, this.camera)

      this.cameraPosition = {
        x: Math.round(this.camera.position.x * 100) / 100,
        y: Math.round(this.camera.position.y * 100) / 100,
        z: Math.round(this.camera.position.z * 100) / 100
      }
    },

    /**
     * Add/remove a group of objects based on a desired visibility flag.
     * The scene graph itself is the authority for what is currently shown:
     * repeated calls with the same flag never double-add or accidentally
     * remove anything.
     */
    applyObjectVisibility(objects, visible) {
      if (!this.scene) {
        return
      }
      for (const object of objects) {
        const isInScene = object.parent === this.scene
        if (visible && !isInScene) {
          this.scene.add(object)
        } else if (!visible && isInScene) {
          this.scene.remove(object)
        }
      }
      if (this.renderer && this.camera) {
        this.renderer.render(this.scene, this.camera)
      }
    },

    setPyramidsVisible(visible) {
      this.pyramidsVisible = visible
      this.applyObjectVisibility(this.pyramids, visible)
    },

    togglePyramids() {
      this.setPyramidsVisible(!this.pyramidsVisible)
    },

    setAxisLinesVisible(visible) {
      this.axisLinesVisible = visible
      this.applyObjectVisibility(this.axisLines, visible)
    },

    toggleAxisLines() {
      this.setAxisLinesVisible(!this.axisLinesVisible)
    },

    /**
     * Single rAF-driven loop. Re-calling startLoop while a loop is already
     * queued is a no-op, so repeated init can never stack render loops.
     */
    startLoop() {
      if (this.animationFrameId !== null) {
        return
      }
      this.animationFrameId = window.requestAnimationFrame(this.tick)
    },

    stopLoop() {
      if (this.animationFrameId !== null) {
        window.cancelAnimationFrame(this.animationFrameId)
        this.animationFrameId = null
      }
    },

    tick() {
      // Only keep looping while a live renderer/controls pair exists.
      if (!this.renderer || !this.controls) {
        this.animationFrameId = null
        return
      }

      this.controls.update()

      // Update reactive camera position for real-time display
      if (this.camera) {
        this.cameraPosition = {
          x: Math.round(this.camera.position.x * 100) / 100,
          y: Math.round(this.camera.position.y * 100) / 100,
          z: Math.round(this.camera.position.z * 100) / 100
        }
      }

      this.animationFrameId = window.requestAnimationFrame(this.tick)
    },

    /**
     * Tear down everything init created: cancel the queued animation frame,
     * detach the controls change and window resize listeners, release
     * renderer/controls resources and remove the canvas from the DOM.
     * Safe to call more than once and before any init has run.
     */
    dispose() {
      this.stopLoop()

      if (this.controls) {
        this.controls.removeEventListener('change', this.onControlsChange)
        window.removeEventListener('resize', this.onWindowResize, true)
        this.controls.dispose()
      }

      if (this.scene) {
        this.scene.traverse((object) => {
          if (object.geometry) {
            object.geometry.dispose()
          }
          if (object.material) {
            const materials = Array.isArray(object.material)
              ? object.material
              : [object.material]
            materials.forEach((material) => material.dispose())
          }
        })
      }

      if (this.renderer) {
        const canvas = this.renderer.domElement
        if (canvas && canvas.parentNode) {
          canvas.parentNode.removeChild(canvas)
        }
        this.renderer.dispose()
      }

      this.camera = null
      this.controls = null
      this.scene = null
      this.renderer = null
      this.container = null
      this.axisLines = []
      this.pyramids = []
      this.animationFrameId = null
    },

    async init({ width, height, el }) {
      // Re-initializing must not stack loops, listeners or canvases.
      this.dispose()

      this.container = markRaw(el)
      this.setViewportSize({ width, height })
      this.initializeRenderer(el)
      this.initializeCamera()
      this.initializeControls()
      this.initializeScene()

      // Initial scene rendering
      this.renderer.render(this.scene, this.camera)

      // Re-render when the controls change. Same function reference is used
      // on dispose, so the listener can always be detached again.
      this.controls.addEventListener('change', this.onControlsChange)
      window.addEventListener('resize', this.onWindowResize, true)

      this.startLoop()
    }
  }
})

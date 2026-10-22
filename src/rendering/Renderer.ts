import * as THREE from 'three';
import { atmo, installAtmosphereChunks } from './Atmosphere';
import { CloudSky } from './CloudSky';
import { getNoise2D } from './NoiseTextures';
import { LUMA_FRAGMENT, POST_FRAGMENT, POST_VERTEX } from './PostShader';

/** Per-camera-mode sensor/lens character, blended by the camera rig. */
export interface LensProfile {
  barrel: number;
  chroma: number;
  noise: number;
  sharpen: number;
  vignette: number;
  saturation: number;
  contrast: number;
  tint: THREE.Color;
  /** Exposure compensation multiplier. */
  ev: number;
  /** Shutter fraction for motion blur. */
  shutter: number;
}

export interface RenderSettings {
  renderScale: number;
  motionBlur: boolean;
  noiseAmount: number;
  cloudSteps: number;
  skyDivisor: number;
}

/**
 * Frame pipeline:
 *   sky (low-res raymarch) → scene (HDR, + depth) → glass pass (windshield
 *   water/interior mask) → sensor post → screen.
 * Also owns auto exposure and the reflection environment captured from the sky.
 */
const _dreadTint = new THREE.Color();

export class Renderer {
  readonly gl: THREE.WebGLRenderer;
  readonly sky = new CloudSky();
  readonly sceneRT: THREE.WebGLRenderTarget;
  readonly glassRT: THREE.WebGLRenderTarget;
  private readonly lumaRT: THREE.WebGLRenderTarget;
  private readonly postMat: THREE.ShaderMaterial;
  private readonly lumaMat: THREE.ShaderMaterial;
  private readonly fsScene = new THREE.Scene();
  private readonly fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private readonly fsQuad: THREE.Mesh;
  private readonly prevVP = new THREE.Matrix4();
  private readonly curVP = new THREE.Matrix4();
  private hasPrev = false;

  // Reflection environment.
  private readonly envScene = new THREE.Scene();
  private readonly cubeRT: THREE.WebGLCubeRenderTarget;
  private readonly cubeCam: THREE.CubeCamera;
  private readonly pmrem: THREE.PMREMGenerator;
  private envRT: THREE.WebGLRenderTarget | null = null;
  private envTimer = 0;

  // Auto exposure.
  private readonly lumaBuf = new Float32Array(32 * 18 * 4);
  private lumaPending = false;
  private measuredLogLum = Math.log(0.15);
  exposure = 1.2;
  /** 0..1 how close and present a tornado is: darker, greener, tighter grade. */
  dread = 0;
  private frame = 0;

  /** Per-step CPU timings (ms) of the last frame, for profiling. */
  readonly timings: Record<string, number> = {};
  private mark(label: string, t0: number): number {
    const t = performance.now();
    this.timings[label] = t - t0;
    return t;
  }

  /** Extra effects set by gameplay each frame. */
  fade = 0;
  flashWhite = 0;
  damage = 0;
  glassVeil = 0.5;

  settings: RenderSettings = { renderScale: 0.75, motionBlur: true, noiseAmount: 1, cloudSteps: 30, skyDivisor: 3.5 };
  /** Automatic resolution multiplier (0.55–1) applied on top of the user's render scale. */
  dynamicScale = 1;
  private cssW = 1;
  private cssH = 1;
  private width = 1;
  private height = 1;

  constructor(canvas: HTMLCanvasElement) {
    installAtmosphereChunks();
    this.gl = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false });
    this.gl.outputColorSpace = THREE.SRGBColorSpace;
    this.gl.toneMapping = THREE.NoToneMapping;
    this.gl.autoClear = true;

    this.sceneRT = new THREE.WebGLRenderTarget(4, 4, {
      type: THREE.HalfFloatType,
      depthBuffer: true,
      samples: 0,
    });
    this.sceneRT.depthTexture = new THREE.DepthTexture(4, 4, THREE.UnsignedIntType);
    this.glassRT = new THREE.WebGLRenderTarget(4, 4, { type: THREE.UnsignedByteType, depthBuffer: true });
    this.lumaRT = new THREE.WebGLRenderTarget(32, 18, { type: THREE.FloatType, depthBuffer: false });

    atmo.uSkyTex.value = this.sky.target.texture;

    this.postMat = new THREE.ShaderMaterial({
      uniforms: {
        tScene: { value: this.sceneRT.texture },
        tDepth: { value: this.sceneRT.depthTexture },
        tGlass: { value: this.glassRT.texture },
        tNoise: { value: getNoise2D() },
        uTexel: { value: new THREE.Vector2() },
        uTime: { value: 0 },
        uExposure: { value: 1 },
        uBarrel: { value: 0 },
        uChroma: { value: 0 },
        uNoise: { value: 0.02 },
        uSharpen: { value: 0.3 },
        uVignette: { value: 0.3 },
        uSaturation: { value: 0.9 },
        uContrast: { value: 1.05 },
        uTint: { value: new THREE.Color(1, 1, 1) },
        uBlur: { value: 0.4 },
        uInvViewProj: { value: new THREE.Matrix4() },
        uPrevViewProj: { value: new THREE.Matrix4() },
        uGlassVeil: { value: 0.5 },
        uFade: { value: 0 },
        uFlashWhite: { value: 0 },
        uDamage: { value: 0 },
      },
      vertexShader: POST_VERTEX,
      fragmentShader: POST_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.lumaMat = new THREE.ShaderMaterial({
      uniforms: { tScene: { value: this.sceneRT.texture }, tGlass: { value: this.glassRT.texture }, uSrcTexel: { value: new THREE.Vector2() } },
      vertexShader: POST_VERTEX,
      fragmentShader: LUMA_FRAGMENT,
      depthTest: false,
      depthWrite: false,
    });
    this.fsQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), this.postMat);
    this.fsQuad.frustumCulled = false;
    this.fsScene.add(this.fsQuad);

    // Environment capture of the sky for wet-road and glass reflections.
    this.cubeRT = new THREE.WebGLCubeRenderTarget(64, { type: THREE.HalfFloatType });
    this.cubeCam = new THREE.CubeCamera(1, 100000, this.cubeRT);
    const envSphere = new THREE.Mesh(new THREE.SphereGeometry(5000, 32, 16), this.sky.createEnvMaterial());
    envSphere.frustumCulled = false;
    this.envScene.add(envSphere, this.cubeCam);
    this.pmrem = new THREE.PMREMGenerator(this.gl);
  }

  setSize(cssWidth: number, cssHeight: number): void {
    this.cssW = cssWidth;
    this.cssH = cssHeight;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const s = Math.min(1, this.settings.renderScale) * this.dynamicScale;
    this.width = Math.max(64, Math.round(cssWidth * Math.min(dpr, 1.5) * s));
    this.height = Math.max(36, Math.round(cssHeight * Math.min(dpr, 1.5) * s));
    // The canvas itself is only as big as the render; the browser scales it up.
    // (Running the sensor pass at full Retina resolution cost more than the whole scene.)
    this.gl.setPixelRatio(1);
    this.gl.setSize(this.width, this.height, false);
    const canvas = this.gl.domElement;
    canvas.style.width = cssWidth + 'px';
    canvas.style.height = cssHeight + 'px';
    this.sceneRT.setSize(this.width, this.height);
    this.glassRT.setSize(Math.round(this.width / 2), Math.round(this.height / 2));
    this.sky.setQuality(this.settings.cloudSteps, this.settings.skyDivisor);
    this.sky.resize(this.width, this.height);
    atmo.uViewport.value.set(this.width, this.height);
    (this.postMat.uniforms.uTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
    (this.lumaMat.uniforms.uSrcTexel.value as THREE.Vector2).set(1 / this.width, 1 / this.height);
  }

  /**
   * Adaptive resolution: called with the measured frame time once per second.
   * Drops resolution quickly when frames run long, recovers slowly.
   */
  adaptResolution(avgFrameMs: number): void {
    let next = this.dynamicScale;
    if (avgFrameMs > 19) next = Math.max(0.55, this.dynamicScale - 0.08);
    else if (avgFrameMs < 12.5) next = Math.min(1, this.dynamicScale + 0.04);
    if (Math.abs(next - this.dynamicScale) > 1e-3) {
      this.dynamicScale = next;
      this.setSize(this.cssW, this.cssH);
      this.resetMotion();
    }
  }

  get renderWidth(): number {
    return this.width;
  }
  get renderHeight(): number {
    return this.height;
  }

  /** Re-capture the reflection environment around `pos`. */
  updateEnvironment(scene: THREE.Scene, pos: THREE.Vector3, force = false, dt = 0): void {
    this.envTimer -= dt;
    if (!force && this.envTimer > 0) return;
    this.envTimer = 4;
    this.cubeCam.position.copy(pos);
    this.cubeCam.position.y += 2;
    this.cubeCam.update(this.gl, this.envScene);
    this.envRT = this.pmrem.fromCubemap(this.cubeRT.texture, this.envRT ?? undefined);
    scene.environment = this.envRT.texture;
  }

  render(
    scene: THREE.Scene,
    camera: THREE.PerspectiveCamera,
    glassScene: THREE.Scene | null,
    lens: LensProfile,
    time: number,
    dt: number,
  ): void {
    const gl = this.gl;
    this.frame++;
    let tm = performance.now();
    camera.updateMatrixWorld();

    // 1. Sky.
    this.sky.render(gl, camera, time);
    tm = this.mark('sky', tm);

    // 2. Scene.
    gl.setRenderTarget(this.sceneRT);
    gl.setClearColor(0x000000, 1);
    gl.clear();
    gl.render(scene, camera);
    tm = this.mark('scene', tm);

    // 3. Glass: windshield water offsets + interior mask.
    gl.setRenderTarget(this.glassRT);
    gl.setClearColor(new THREE.Color(0.5, 0.5, 0), 0);
    gl.clear();
    if (glassScene) gl.render(glassScene, camera);
    tm = this.mark('glass', tm);

    // 4. Exposure measurement (async readback every few frames).
    if (this.frame % 4 === 0 && !this.lumaPending) {
      this.fsQuad.material = this.lumaMat;
      gl.setRenderTarget(this.lumaRT);
      gl.render(this.fsScene, this.fsCam);
      this.lumaPending = true;
      gl.readRenderTargetPixelsAsync(this.lumaRT, 0, 0, 32, 18, this.lumaBuf)
        .then(() => {
          let acc = 0;
          let wsum = 0;
          for (let i = 0; i < 32 * 18; i++) {
            // Centre-weighted metering.
            const x = (i % 32) / 31 - 0.5;
            const y = Math.floor(i / 32) / 17 - 0.5;
            const cw = 1.2 - Math.min(1, Math.hypot(x, y) * 1.6);
            acc += this.lumaBuf[i * 4] * cw;
            wsum += this.lumaBuf[i * 4 + 1] * cw;
          }
          const v = wsum > 1e-3 ? acc / wsum : this.measuredLogLum;
          if (Number.isFinite(v)) this.measuredLogLum = v;
          this.lumaPending = false;
        })
        .catch(() => {
          this.lumaPending = false;
        });
    }
    tm = this.mark('luma', tm);
    const avgLum = Math.exp(this.measuredLogLum);
    const target = THREE.MathUtils.clamp((0.17 / Math.max(avgLum, 1e-4)) * lens.ev * (1 - 0.15 * this.dread), 0.35, 24);
    // Brighten slowly, darken quickly — lightning blows out before the camera reacts.
    const rate = target > this.exposure ? 1.1 : 2.6;
    this.exposure += (target - this.exposure) * (1 - Math.exp(-rate * dt));

    // 5. Post to screen.
    const u = this.postMat.uniforms;
    this.curVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    (u.uInvViewProj.value as THREE.Matrix4).copy(this.curVP).invert();
    (u.uPrevViewProj.value as THREE.Matrix4).copy(this.hasPrev ? this.prevVP : this.curVP);
    this.prevVP.copy(this.curVP);
    this.hasPrev = true;
    u.uTime.value = time;
    u.uExposure.value = this.exposure;
    u.uBarrel.value = lens.barrel;
    u.uChroma.value = lens.chroma;
    u.uNoise.value = 0.022 * lens.noise * this.settings.noiseAmount;
    u.uSharpen.value = lens.sharpen;
    // Dread: near a tornado the light goes dim, sickly green-grey and closes in.
    const dr = this.dread;
    u.uVignette.value = lens.vignette + 0.28 * dr;
    u.uSaturation.value = lens.saturation * (1 - 0.22 * dr);
    u.uContrast.value = lens.contrast + 0.14 * dr;
    (u.uTint.value as THREE.Color).copy(lens.tint).multiply(_dreadTint.setRGB(1 - 0.16 * dr, 1 - 0.02 * dr, 1 - 0.12 * dr));
    // Blur scales with frame time so it reads as a fixed 1/60 s-ish shutter.
    u.uBlur.value = this.settings.motionBlur ? lens.shutter * Math.min(1.5, 1 / 60 / Math.max(dt, 1 / 240)) : 0;
    u.uGlassVeil.value = this.glassVeil;
    u.uFade.value = this.fade;
    u.uFlashWhite.value = this.flashWhite;
    u.uDamage.value = this.damage;
    this.fsQuad.material = this.postMat;
    gl.setRenderTarget(null);
    gl.render(this.fsScene, this.fsCam);
    this.mark('post', tm);
  }

  /** Forget last frame's camera (after a teleport or camera switch) so it doesn't smear. */
  resetMotion(): void {
    this.hasPrev = false;
  }
}

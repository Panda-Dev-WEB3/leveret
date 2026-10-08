// 📖 Docs: obsidian/frontend/components/scene.md

/**
 * Builds the grass field scene: rolling, noise-displaced dunes carpeted in ~190k
 * instanced blades under a procedural sky dome, rendered to an offscreen target
 * and composited to screen through a depth-of-field pass.
 *
 * Plain TypeScript with no React in it — the component owns mounting, the
 * ticker subscription and teardown; this module owns the three.js graph.
 */

import * as THREE from "three";

import {
  GRASS_FIELD_CONFIG as CONFIG,
  GRASS_FIELD_SEED,
} from "./grass-field.config";
import {
  createHeightSampler,
  createNoise2D,
  mulberry32,
  terrainNormal,
} from "./terrain";
import {
  BEND_SPRING_FRAGMENT_SHADER,
  BEND_STAMP_FRAGMENT_SHADER,
  BLOOM_BLUR_FRAGMENT_SHADER,
  BLOOM_BRIGHT_FRAGMENT_SHADER,
  DOF_FRAGMENT_SHADER,
  DOF_VERTEX_SHADER,
  GRASS_FRAGMENT_SHADER,
  GRASS_VERTEX_SHADER,
  GROUND_FRAGMENT_SHADER,
  GROUND_VERTEX_SHADER,
  SKY_FRAGMENT_SHADER,
  SKY_VERTEX_SHADER,
} from "./shaders";
import { createSunShadowMap } from "./sun-shadow";
import { createParticles, type ParticleHandle } from "./particles";
import { createFloatingTv, type TvHandle } from "./tv";
import { byTier, clampedPixelRatio, type DeviceTier } from "@/lib/scene/device";

/**
 * Every colour the control panel can reach, and where it lives.
 *
 * A registry rather than a rebuild: these are all `THREE.Color` uniforms, so a
 * change is one `.set()` on the next frame — no geometry, no shader recompile,
 * no 420,000 blades regenerated. The `linear` flag marks the uniforms whose
 * shader treats them as linear light (the sky writes linear and lets the
 * composite encode), which have to be converted on the way in or every edit
 * silently lightens them.
 */
export interface SceneColorControl {
  key: string;
  /** Label for the panel. */
  label: string;
  /** Grouping for the panel. */
  group: string;
  /**
   * Where this colour lives in `grass-field.config.ts`, dotted — e.g.
   * `colors.tip`, `tv.light.color`. Carried so the panel can emit a snippet
   * that is pasteable into the config rather than a list of opaque keys.
   */
  path: string;
  /** The configured default, as `#rrggbb`. */
  value: string;
}

/**
 * A scalar the panel may edit. Same contract as the colours: it must be a live
 * uniform (or a transform), never anything that would need the field rebuilt.
 */
export interface SceneNumberControl {
  key: string;
  label: string;
  group: string;
  /** Dotted path in `grass-field.config.ts`. */
  path: string;
  value: number;
  min: number;
  max: number;
  step: number;
}

/** Imperative handle the React leaf drives. */
export interface GrassSceneHandle {
  /** The colours the panel may edit, with their current values. */
  colorControls: SceneColorControl[];
  /** Set one of them, by `key`. Takes effect on the next frame. */
  setColor: (key: string, hex: string) => void;
  /** The scalars the panel may edit. */
  numberControls: SceneNumberControl[];
  setNumber: (key: string, value: number) => void;
  /** Advance the clocks and draw one frame. */
  render: () => void;
  /** Re-read the canvas size — pixel ratio, drawing buffer and camera aspect. */
  resize: () => void;
  /** Aim the breeze at a viewport point (client coordinates). */
  setPointer: (clientX: number, clientY: number) => void;
  /** Park the breeze off the field, so it is simply absent. */
  parkPointer: () => void;
  /** Blow one strong gust across the field that then calms (`windGust`). */
  gust: () => void;
  /**
   * Re-apply every per-tier budget: DPR, blade and mote counts, MSAA, bloom.
   * Sizes, counts and uniforms only — it never changes a define, so it never
   * compiles a program.
   */
  retune: (tier: DeviceTier) => void;
  /** Release every GPU resource this scene allocated. */
  dispose: () => void;
}

/** Hand-rolled quaternion multiply on `Vector4`, matching the source field builder. */
const multiplyQuaternions = (a: THREE.Vector4, b: THREE.Vector4): void => {
  const qax = a.x;
  const qay = a.y;
  const qaz = a.z;
  const qaw = a.w;
  const qbx = b.x;
  const qby = b.y;
  const qbz = b.z;
  const qbw = b.w;
  a.set(
    qax * qbw + qaw * qbx + qay * qbz - qaz * qby,
    qay * qbw + qaw * qby + qaz * qbx - qax * qbz,
    qaz * qbw + qaw * qbz + qax * qby - qay * qbx,
    qaw * qbw - qax * qbx - qay * qby - qaz * qbz,
  );
};

export interface GrassSceneOptions {
  /** Device tier at construction. Retune later with `handle.retune(tier)`. */
  tier?: DeviceTier;
  /** Fraction (0–1) of the scene's network requests that have finished. */
  onLoadProgress?: (fraction: number) => void;
  /**
   * Called once, after every texture and the television have settled **and** a
   * frame has been drawn with them — so shader compilation is already paid for
   * and nothing pops in after a preloader lifts.
   */
  onReady?: () => void;
}

export const createGrassScene = (
  canvas: HTMLCanvasElement,
  { tier: initialTier = "desktop", onLoadProgress, onReady }: GrassSceneOptions = {},
): GrassSceneHandle => {
  const { colors, blade, camera: cameraConfig, pointer } = CONFIG;

  /* ---------------------------------------------------------------- renderer */

  let tier: DeviceTier = initialTier;

  // `antialias: false` on every tier: the default framebuffer only ever draws
  // the full-screen composite quad, so MSAA there anti-aliased nothing. Geometry
  // is anti-aliased on the offscreen scene target instead (`tiers.msaaSamples`).
  // Opaque canvas, no stencil anywhere in the chain.
  const renderer = new THREE.WebGLRenderer({
    canvas,
    antialias: false,
    alpha: false,
    stencil: false,
    powerPreference: tier === "desktop" ? "high-performance" : "default",
  });
  renderer.setPixelRatio(clampedPixelRatio(tier));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = CONFIG.renderer.toneMappingExposure;

  const scene = new THREE.Scene();
  // No `scene.fog`: it only reaches materials that implement it, and every
  // material here is custom. The blades and the ground apply the same
  // exponential fog from these uniforms instead, so they recede together — which
  // they did not when the fog reached only the ground, leaving the far hills
  // hazed into the sky behind fully saturated grass.
  const fogColorUniform: THREE.IUniform<THREE.Color> = {
    value: new THREE.Color(colors.haze).convertSRGBToLinear(),
  };
  const fogDensityUniform: THREE.IUniform<number> = {
    value: CONFIG.fog.density,
  };

  // The television's screen, as seen by everything it lights. One set of
  // uniform objects shared by the grass and the ground, so the pool of light
  // under the set is continuous across the two materials instead of being two
  // pools that drift apart.
  const tvPositionUniform: THREE.IUniform<THREE.Vector3> = {
    value: new THREE.Vector3(),
  };
  const tvDirectionUniform: THREE.IUniform<THREE.Vector3> = {
    value: new THREE.Vector3(0, 0, 1),
  };
  const tvFlickerUniform: THREE.IUniform<number> = { value: 1 };
  const tvLightUniforms = {
    uTvPosition: tvPositionUniform,
    uTvDirection: tvDirectionUniform,
    uTvColor: { value: new THREE.Color(CONFIG.tv.light.color) },
    // Annotated, not inferred: the config is `as const`, so an inferred uniform
    // takes the *literal* type of its default and the panel cannot write to it.
    uTvIntensity: { value: CONFIG.tv.light.intensity } as THREE.IUniform<number>,
    uTvRadius: { value: CONFIG.tv.light.radius } as THREE.IUniform<number>,
    uTvFocus: { value: CONFIG.tv.light.focus } as THREE.IUniform<number>,
    uTvFlicker: tvFlickerUniform,
  };

  // Placed once and never re-aimed — no orbit, zoom, pan or parallax. The only
  // motion is a few centimetres of handheld sway applied per frame as an offset
  // from this placement (see `camera.sway`), which is why the placement is kept
  // rather than accumulated into. Height is resolved against the terrain further
  // down, once the height sampler exists.
  const camera = new THREE.PerspectiveCamera(
    cameraConfig.fov,
    1,
    cameraConfig.near,
    cameraConfig.far,
  );

  /* -------------------------------------------------------------------- sun */

  const sun = new THREE.Vector3();
  sun.setFromSphericalCoords(
    1,
    THREE.MathUtils.degToRad(90 - CONFIG.sky.sunElevationDeg),
    THREE.MathUtils.degToRad(CONFIG.sky.sunAzimuthDeg),
  );

  /* --------------------------------------------------------------- textures */

  // One manager for every request the scene makes, so progress is the scene's
  // own and not whatever else happens to use three's global default manager.
  const loadingManager = new THREE.LoadingManager();
  // Progress is half network (the manager) and half the blade build, which is
  // sliced across frames and can outlast the requests on a slow CPU.
  let networkFraction = 0;
  let buildFraction = 0;
  const reportProgress = (): void => {
    onLoadProgress?.((networkFraction + buildFraction) / 2);
  };
  loadingManager.onProgress = (_url, loaded, total) => {
    if (total > 0) networkFraction = loaded / total;
    reportProgress();
  };
  // Settled assets, counted explicitly: the manager's own `onLoad` fires early,
  // before the Draco decoder's requests have even started.
  let pendingAssets = 4; // two textures, the television, the blade buffers
  let readyReported = false;
  const settleAsset = (): void => {
    pendingAssets -= 1;
  };

  const loader = new THREE.TextureLoader(loadingManager);
  const grassTexture = loader.load(CONFIG.textures.diffuse, settleAsset, undefined, settleAsset);
  grassTexture.colorSpace = THREE.SRGBColorSpace; // diffuse is colour data
  // alpha is data — stays linear
  const alphaMap = loader.load(CONFIG.textures.alpha, settleAsset, undefined, settleAsset);

  /* --------------------------------------------------------------- the sky */

  // Typed handles on the uniforms the render loop writes. The uniform objects
  // themselves stay inferred object literals so they satisfy three's
  // `{ [uniform: string]: IUniform }` without an assertion.
  const skyTimeUniform: THREE.IUniform<number> = { value: 0 };
  // Shared with the ground, so one cloud shadow crosses both as a single band.
  const grassTimeUniform: THREE.IUniform<number> = { value: 0 };
  const windTimeUniform: THREE.IUniform<number> = { value: 0 };
  const windStrengthUniform: THREE.IUniform<number> = { value: 1 };
  const windLeanUniform: THREE.IUniform<number> = { value: 0 };
  const windWaveUniform: THREE.IUniform<number> = { value: CONFIG.windGust.wave };

  const skyUniforms = {
    uTop: { value: new THREE.Color(colors.skyTop).convertSRGBToLinear() },
    uHorizon: {
      value: new THREE.Color(colors.skyHorizon).convertSRGBToLinear(),
    },
    uSunColor: { value: new THREE.Color(colors.sun).convertSRGBToLinear() },
    uSunDir: { value: sun.clone() },
    uTime: skyTimeUniform,
    uCloudColor: { value: new THREE.Color(colors.cloud).convertSRGBToLinear() },
    uCloudCover: { value: CONFIG.sky.cloudCover } as THREE.IUniform<number>,
    uCloudOpacity: { value: CONFIG.sky.cloudOpacity } as THREE.IUniform<number>,
    uCloudBrightness: { value: CONFIG.sky.cloudBrightness } as THREE.IUniform<number>,
    uCloudGate: {
      value: new THREE.Vector2(CONFIG.sky.cloudGateLow, CONFIG.sky.cloudGateHigh),
    },
    uCloudSpeed: { value: CONFIG.sky.cloudSpeed },
    uHorizonGlow: {
      value: new THREE.Color(colors.horizonGlow).convertSRGBToLinear(),
    },
    uHorizonGlowStrength: { value: CONFIG.sky.horizonGlowStrength },
  };

  const skyMaterial = new THREE.ShaderMaterial({
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    // Exposure-independent: the grass exposure can move without washing the
    // horizon band this camera frames out to white.
    toneMapped: false,
    uniforms: skyUniforms,
    vertexShader: SKY_VERTEX_SHADER,
    fragmentShader: SKY_FRAGMENT_SHADER,
  });

  const skyGeometry = new THREE.SphereGeometry(
    CONFIG.sky.radius,
    CONFIG.sky.widthSegments,
    CONFIG.sky.heightSegments,
  );
  const sky = new THREE.Mesh(skyGeometry, skyMaterial);
  sky.frustumCulled = false;
  scene.add(sky);

  /* ---------------------------------------------------------------- terrain */

  // One sampler feeds the ground mesh, every blade's Y offset and the camera
  // height, so the blades sit exactly on the surface and the eye sits exactly in
  // the canopy however the relief is retuned.
  const getYPosition = createHeightSampler(GRASS_FIELD_SEED, CONFIG.terrain);

  const eyeY =
    getYPosition(cameraConfig.x, cameraConfig.z) + cameraConfig.eyeHeight;
  camera.position.set(cameraConfig.x, eyeY, cameraConfig.z);

  /* ----------------------------------------------------------- sun shadow */

  const shadow = createSunShadowMap(getYPosition, sun, {
    centerX: cameraConfig.x,
    centerZ: cameraConfig.z,
    // Covers the blade disc, with room for blockers just outside it.
    size: CONFIG.fieldRadius * 2.4,
    resolution: CONFIG.grassLight.sunShadow.resolution,
    reach: CONFIG.grassLight.sunShadow.reach,
    steps: CONFIG.grassLight.sunShadow.steps,
    softness: CONFIG.grassLight.sunShadow.softness,
  });

  const sunShadowUniforms = {
    uShadowMap: { value: shadow.texture },
    uShadowOrigin: { value: shadow.origin },
    uShadowSize: { value: shadow.size },
    uShadowStrength: { value: CONFIG.grassLight.sunShadow.strength },
  };


  // `yawDeg` chooses the direction the shot looks; the *aim* is settled below,
  // once the television has been placed, by pointing the camera at it. Framing
  // the subject beats guessing a pitch that happens to put it near the middle.
  const yaw = THREE.MathUtils.degToRad(cameraConfig.yawDeg);

  // The ground runs far past the blades so the relief carries to the horizon
  // instead of ending on a visible edge; fog dissolves the far end of it.
  const groundGeometry = new THREE.PlaneGeometry(
    CONFIG.groundWidth,
    CONFIG.groundWidth,
    CONFIG.groundSegments,
    CONFIG.groundSegments,
  );
  groundGeometry.rotateX(-Math.PI / 2);
  const groundPosition = groundGeometry.attributes.position;
  for (let i = 0; i < groundPosition.count; i++) {
    groundPosition.setY(
      i,
      getYPosition(groundPosition.getX(i), groundPosition.getZ(i)),
    );
  }
  groundGeometry.computeVertexNormals();

  const groundMaterial = new THREE.ShaderMaterial({
    uniforms: {
      uBaseColor: { value: new THREE.Color(colors.groundBase) },
      uTipColor: { value: new THREE.Color(colors.groundTip) },
      uSunColor: { value: new THREE.Color(colors.sun) },
      uSkyColor: { value: new THREE.Color(colors.skyLight) },
      uSunDir: { value: sun.clone() },
      uAmbient: { value: CONFIG.grassLight.ambient },
      uDiffuse: { value: CONFIG.grassLight.diffuse },
      uTerrainContrast: {
        value: new THREE.Vector2(...CONFIG.grassLight.terrainContrast),
      },
      uTime: grassTimeUniform,
      uCloudShadowScale: { value: CONFIG.grassLight.cloudShadow.scale },
      uCloudShadowSpeed: { value: CONFIG.grassLight.cloudShadow.speed },
      uCloudShadowStrength: { value: CONFIG.grassLight.cloudShadow.strength },
      uFogColor: fogColorUniform,
      uFogDensity: fogDensityUniform,
      ...tvLightUniforms,
      ...sunShadowUniforms,
    },
    vertexShader: GROUND_VERTEX_SHADER,
    fragmentShader: GROUND_FRAGMENT_SHADER,
  });
  const ground = new THREE.Mesh(groundGeometry, groundMaterial);
  scene.add(ground);

  /* ------------------------------------------------------------- the field */

  // Preallocated typed arrays, filled in slices across frames (see
  // `buildBlades`). The old build pushed into plain arrays and allocated three
  // Vector3s per blade — 1.4 M objects in one 110 ms task on a desktop, several
  // times that on a phone, freezing the preloader while it ran.
  const total = CONFIG.instances;
  const offsets = new Float32Array(total * 3);
  const orientations = new Float32Array(total * 4);
  const stretches = new Float32Array(total);
  const halfRootAngleSin = new Float32Array(total);
  const halfRootAngleCos = new Float32Array(total);
  const groundLights = new Float32Array(total);
  /** Per instance: x = colour/brightness tint, y = canopy occlusion. */
  const variations = new Float32Array(total * 2);

  // Patch field for blade height. Seeded apart from the relief so retuning one
  // does not reshuffle the other.
  const clumpNoise = createNoise2D((GRASS_FIELD_SEED ^ 0x85ebca6b) >>> 0);

  const quaternion0 = new THREE.Vector4();
  const quaternion1 = new THREE.Vector4();

  // Layout stream, derived from the same seed as the relief but independent of
  // it — so the field comes back identical on every rebuild.
  const rand = mulberry32((GRASS_FIELD_SEED ^ 0x9e3779b9) >>> 0);

  // The camera heading as a polar angle in the scatter's (cos, sin) → (x, z)
  // convention: yaw 0 looks down -Z.
  const headingTheta = Math.atan2(-Math.cos(yaw), Math.sin(yaw));
  const fieldArc = THREE.MathUtils.degToRad(CONFIG.fieldArcDegrees);

  /** Rotation about a principal axis as a unit quaternion, written into `out`. */
  const axisQuaternion = (
    out: THREE.Vector4,
    axis: 0 | 1 | 2,
    angle: number,
  ): THREE.Vector4 => {
    const half = Math.sin(angle / 2);
    return out.set(
      axis === 0 ? half : 0,
      axis === 1 ? half : 0,
      axis === 2 ? half : 0,
      Math.cos(angle / 2),
    );
  };

  const writeBlade = (i: number): void => {
    // Polar scatter from the camera, within the arc it can actually see. `sqrt`
    // would give uniform area density; the configured bias concentrates blades
    // where they cover pixels instead of wasting them on the far distance.
    const radius =
      CONFIG.fieldRadius * Math.pow(rand(), CONFIG.fieldDensityBias);
    const theta = headingTheta + (rand() - 0.5) * fieldArc;
    const x = cameraConfig.x + Math.cos(theta) * radius;
    const z = cameraConfig.z + Math.sin(theta) * radius;
    offsets[i * 3] = x;
    offsets[i * 3 + 1] = getYPosition(x, z);
    offsets[i * 3 + 2] = z;

    // Bake how much sun the ground under this blade catches. Blades are unlit
    // geometry, so this is the only thing that makes a mound read as a mound.
    const normal = terrainNormal(getYPosition, x, z);
    groundLights[i] = Math.max(
      normal.x * sun.x + normal.y * sun.y + normal.z * sun.z,
      0,
    );

    // 1) random full Y-axis rotation
    let angle = Math.PI - rand() * (2 * Math.PI);
    halfRootAngleSin[i] = Math.sin(0.5 * angle);
    halfRootAngleCos[i] = Math.cos(0.5 * angle);
    axisQuaternion(quaternion0, 1, angle);

    // 2) small random X-axis tilt, combined in
    angle = rand() * 0.5 - 0.25;
    multiplyQuaternions(quaternion0, axisQuaternion(quaternion1, 0, angle));

    // 3) small random Z-axis tilt, combined again
    angle = rand() * 0.5 - 0.25;
    multiplyQuaternions(quaternion0, axisQuaternion(quaternion1, 2, angle));

    orientations[i * 4] = quaternion0.x;
    orientations[i * 4 + 1] = quaternion0.y;
    orientations[i * 4 + 2] = quaternion0.z;
    orientations[i * 4 + 3] = quaternion0.w;

    // Height: a patch value times a within-patch draw. The original picked a
    // flat random for two thirds of blades and a taller flat random for the
    // rest, which produces an even spread of every height everywhere — grass
    // does not do that. Patches give the field its coarse structure and the
    // skewed draw keeps tall blades to a minority inside each patch.
    const patch =
      1 +
      CONFIG.height.clumpAmount *
        clumpNoise(x / CONFIG.height.clumpScale, z / CONFIG.height.clumpScale);
    const draw = Math.pow(rand(), CONFIG.height.skew);
    stretches[i] =
      patch *
      (CONFIG.height.minStretch +
        (CONFIG.height.maxStretch - CONFIG.height.minStretch) * draw);

    // A blade shorter than its own patch is buried under its neighbours and sits
    // in their shade. `draw` is already that relative height, so the occlusion
    // comes free — no neighbour search.
    variations[i * 2] = rand();
    variations[i * 2 + 1] = 1 - CONFIG.grassLight.canopyAo * (1 - draw);
  };

  // Translated up by half its height so the origin sits at the root: every
  // rotation in the vertex shader then pivots about the ground, which is what
  // makes a blade bend instead of swing. 1x5 segments = six vertex rows, the
  // entire bending resolution — fewer and the bend visibly creases.
  const baseGeometry = new THREE.PlaneGeometry(
    blade.width,
    blade.height,
    1,
    blade.joints,
  ).translate(0, blade.height / 2, 0);

  const grassGeometry = new THREE.InstancedBufferGeometry();
  grassGeometry.index = baseGeometry.index;
  grassGeometry.setAttribute("position", baseGeometry.attributes.position);
  grassGeometry.setAttribute("uv", baseGeometry.attributes.uv);
  const bladeAttributes = [
    new THREE.InstancedBufferAttribute(offsets, 3),
    new THREE.InstancedBufferAttribute(orientations, 4),
    new THREE.InstancedBufferAttribute(stretches, 1),
    new THREE.InstancedBufferAttribute(halfRootAngleSin, 1),
    new THREE.InstancedBufferAttribute(halfRootAngleCos, 1),
    new THREE.InstancedBufferAttribute(groundLights, 1),
    new THREE.InstancedBufferAttribute(variations, 2),
  ];
  const bladeAttributeNames = [
    "offset",
    "orientation",
    "stretch",
    "halfRootAngleSin",
    "halfRootAngleCos",
    "groundLight",
    "variation",
  ];
  bladeAttributes.forEach((attribute, index) =>
    grassGeometry.setAttribute(bladeAttributeNames[index], attribute),
  );
  // Nothing drawn until the buffers are complete — the preloader covers it.
  grassGeometry.instanceCount = 0;
  baseGeometry.dispose();

  /** Longest slice of main-thread time the blade build may take per frame. */
  const BUILD_BUDGET_MS = 8;
  let bladesBuilt = 0;
  /**
   * Fill the next slice of blades. On completion the buffers are flagged for a
   * single upload and the tier's count is applied. Returns whether it is done.
   */
  const buildBlades = (): boolean => {
    if (bladesBuilt >= total) return true;
    const deadline = performance.now() + BUILD_BUDGET_MS;
    // Check the clock every 512 blades, not every blade.
    while (bladesBuilt < total && performance.now() < deadline) {
      const end = Math.min(bladesBuilt + 512, total);
      for (let index = bladesBuilt; index < end; index++) writeBlade(index);
      bladesBuilt = end;
    }
    buildFraction = bladesBuilt / total;
    reportProgress();
    if (bladesBuilt < total) return false;
    for (const attribute of bladeAttributes) attribute.needsUpdate = true;
    grassGeometry.instanceCount = byTier(tier, CONFIG.tiers.instances);
    settleAsset();
    return true;
  };

  // The square the bend map covers: centred on the camera and sized to the blade
  // disc, so every blade the eye can reach has a texel.
  const bendSize = CONFIG.fieldRadius * 2;
  const bendOrigin = new THREE.Vector2(
    cameraConfig.x - bendSize / 2,
    cameraConfig.z - bendSize / 2,
  );

  const grassUniforms = {
    map: { value: grassTexture },
    alphaMap: { value: alphaMap },
    time: grassTimeUniform,
    windTime: windTimeUniform,
    windStrength: windStrengthUniform,
    windLean: windLeanUniform,
    windWave: windWaveUniform,
    bladeHeight: { value: blade.height },
    tipColor: { value: new THREE.Color(colors.tip) },
    bottomColor: { value: new THREE.Color(colors.bottom) },
    uBendMap: { value: null } as THREE.IUniform<THREE.Texture | null>,
    uBendOrigin: { value: bendOrigin },
    uBendSize: { value: bendSize },
    uMouseStrength: {
      value: pointer.strength,
    } as THREE.IUniform<number>,
    uBendReference: { value: pointer.distanceReference } as THREE.IUniform<number>,
    uBendFarStrength: { value: pointer.farStrength } as THREE.IUniform<number>,
    uSunDir: { value: sun.clone() },
    uSunColor: { value: new THREE.Color(colors.sun) },
    uSkyColor: { value: new THREE.Color(colors.skyLight) },
    uDryColor: { value: new THREE.Color(colors.dry) },
    uTintRange: {
      value: new THREE.Vector2(...CONFIG.grassLight.tintRange),
    },
    uTerrainContrast: {
      value: new THREE.Vector2(...CONFIG.grassLight.terrainContrast),
    },
    uCloudShadowScale: { value: CONFIG.grassLight.cloudShadow.scale },
    uCloudShadowSpeed: { value: CONFIG.grassLight.cloudShadow.speed },
    uCloudShadowStrength: { value: CONFIG.grassLight.cloudShadow.strength },
    uAmbient: { value: CONFIG.grassLight.ambient },
    uBounce: { value: CONFIG.grassLight.bounce },
    uDiffuse: { value: CONFIG.grassLight.diffuse },
    uBladeWeight: { value: CONFIG.grassLight.bladeWeight },
    uWrap: { value: CONFIG.grassLight.wrap },
    uRootShade: { value: CONFIG.grassLight.rootShade },
    uSpecular: { value: CONFIG.grassLight.specular },
    uShininess: { value: CONFIG.grassLight.shininess },
    uTranslucency: { value: CONFIG.grassLight.translucency },
    uTranslucencyPower: { value: CONFIG.grassLight.translucencyPower },
    uFogColor: fogColorUniform,
    uFogDensity: fogDensityUniform,
    uFlowerColor: { value: new THREE.Color(colors.flower) },
    uFlowerFraction: { value: CONFIG.grassLight.flowerFraction },
    ...tvLightUniforms,
    ...sunShadowUniforms,
  };

  const grassMaterial = new THREE.ShaderMaterial({
    // A blade is a single quad strip — it must be visible from both sides.
    side: THREE.DoubleSide,
    uniforms: grassUniforms,
    vertexShader: GRASS_VERTEX_SHADER,
    fragmentShader: GRASS_FRAGMENT_SHADER,
  });

  const grassMesh = new THREE.Mesh(grassGeometry, grassMaterial);
  // The base blade's bounding sphere is meaningless once instances are
  // scattered in the shader — leaving culling on pops the whole field.
  grassMesh.frustumCulled = false;
  scene.add(grassMesh);

  /* ------------------------------------------------------------ interaction */

  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();
  const mouseTarget = new THREE.Vector2(pointer.parked, pointer.parked);
  // The cursor in normalised device coordinates. The television turns from this
  // rather than from the ground hit the breeze uses — a ground hit cannot say
  // "above the horizon", and the set needs to be able to look up.
  const pointerNdc = new THREE.Vector2();
  let pointerPresent = false;

  const setPointer = (clientX: number, clientY: number): void => {
    // Measured against the canvas rect rather than the window: the canvas is a
    // section on a page here, not a full-window overlay.
    const rect = canvas.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;

    ndc.x = ((clientX - rect.left) / rect.width) * 2 - 1;
    ndc.y = -((clientY - rect.top) / rect.height) * 2 + 1;
    pointerNdc.copy(ndc);
    pointerPresent = true;
    raycaster.setFromCamera(ndc, camera);

    // The grass never participates: 190k instances exist only on the GPU, and
    // the ground is the same height field anyway. A ray that misses keeps the
    // previous target, so the breeze holds rather than snapping away.
    // The breeze still wants a world point; a ray that misses the ground keeps
    // the previous one, so the wake holds rather than snapping away.
    const hits = raycaster.intersectObject(ground);
    if (hits.length > 0) mouseTarget.set(hits[0].point.x, hits[0].point.z);
  };

  const parkPointer = (): void => {
    mouseTarget.set(pointer.parked, pointer.parked);
    pointerPresent = false;
  };

  /* ------------------------------------------------------------ television */

  // Positioned along the camera's own view direction rather than at a world
  // point, so it stays framed if the camera is re-aimed.
  const viewX = Math.sin(yaw);
  const viewZ = -Math.cos(yaw);

  // Walk the view ray and keep the highest ground in the search window. A fixed
  // distance lands wherever the noise happens to put it — which the first
  // attempt did, in a hollow behind a rise, invisible.
  const [searchFrom, searchTo] = CONFIG.tv.searchRange;
  let tvX = cameraConfig.x + viewX * searchFrom;
  let tvZ = cameraConfig.z + viewZ * searchFrom;
  let crestHeight = -Infinity;
  for (let distance = searchFrom; distance <= searchTo; distance += 0.5) {
    const x = cameraConfig.x + viewX * distance - viewZ * CONFIG.tv.lateral;
    const z = cameraConfig.z + viewZ * distance + viewX * CONFIG.tv.lateral;
    const height = getYPosition(x, z);
    if (height > crestHeight) {
      crestHeight = height;
      tvX = x;
      tvZ = z;
    }
  }
  const tv: TvHandle = createFloatingTv(
    new THREE.Vector3(tvX, crestHeight + CONFIG.tv.hover, tvZ),
    {
      manager: loadingManager,
      onSettled: settleAsset,
      maxTextureSize: byTier(tier, CONFIG.tiers.maxTextureSize),
    },
  );
  scene.add(tv.object);

  /* ------------------------------------------------------------- particles */

  const particles: ParticleHandle = createParticles(
    (GRASS_FIELD_SEED ^ 0xc2b2ae35) >>> 0,
    new THREE.Vector2(cameraConfig.x, cameraConfig.z),
    eyeY - CONFIG.particles.height * 0.35,
  );
  scene.add(particles.object);

  // Lights are back — for the television only. ADR-0030 removed them because
  // nothing read one: the grass, ground and sky are all custom shaders that
  // ignore the light list entirely. The model is different, it arrives with
  // standard materials, and without a light it renders black. Since nothing else
  // in the scene consults them, these two illuminate exactly the set and cost a
  // program recompile on its materials alone.
  const keyLight = new THREE.DirectionalLight(
    new THREE.Color(colors.sun),
    CONFIG.tv.lighting.sun,
  );
  keyLight.position.copy(sun).multiplyScalar(50);
  scene.add(keyLight);
  const fillLight = new THREE.HemisphereLight(
    new THREE.Color(colors.skyLight),
    new THREE.Color(colors.groundTip),
    CONFIG.tv.lighting.sky,
  );
  scene.add(fillLight);

  // Now that the subject exists, frame it.
  camera.lookAt(tv.object.position);

  /* --------------------------------------------------------- the bend map */

  const makeBendTarget = () =>
    new THREE.WebGLRenderTarget(pointer.resolution, pointer.resolution, {
      depthBuffer: false,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      wrapS: THREE.ClampToEdgeWrapping,
      wrapT: THREE.ClampToEdgeWrapping,
    });
  const bendTargets = [makeBendTarget(), makeBendTarget()];
  for (const target of bendTargets) target.texture.colorSpace = THREE.NoColorSpace;
  let bendSource = 0;

  const bendFrom: THREE.IUniform<THREE.Vector2> = {
    value: new THREE.Vector2(pointer.parked, pointer.parked),
  };
  const bendTo: THREE.IUniform<THREE.Vector2> = {
    value: new THREE.Vector2(pointer.parked, pointer.parked),
  };
  const bendDecay: THREE.IUniform<number> = { value: 1 };
  const bendActive: THREE.IUniform<number> = { value: 0 };

  const bendMaterial = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uPrevious: { value: bendTargets[0].texture },
      uOrigin: { value: bendOrigin },
      uSize: { value: bendSize },
      uFrom: bendFrom,
      uTo: bendTo,
      uRadius: { value: pointer.radius } as THREE.IUniform<number>,
      uDecay: bendDecay,
      uActive: bendActive,
      uCamera: { value: new THREE.Vector2(cameraConfig.x, cameraConfig.z) },
      uReference: grassUniforms.uBendReference,
      uFarRadius: { value: pointer.farRadius } as THREE.IUniform<number>,
    },
    vertexShader: DOF_VERTEX_SHADER,
    fragmentShader: BEND_STAMP_FRAGMENT_SHADER,
  });

  const pointerFollow: { seconds: number } = { seconds: pointer.follow };

  /** Recovery time (to ~37%) converted to a per-frame multiplier. */
  const bendRecovery: { seconds: number } = { seconds: pointer.recovery };

  // Inertia: a second ping-ponged pair holding a damped spring per texel that
  // chases the trail above. The grass reads this one, never the trail.
  const springTargets = [makeBendTarget(), makeBendTarget()];
  for (const target of springTargets) target.texture.colorSpace = THREE.NoColorSpace;
  let springSource = 0;
  const bendSpring: { frequency: number; damping: number } = { ...pointer.spring };
  const springDelta: THREE.IUniform<number> = { value: 0 };
  const springStiffness: THREE.IUniform<number> = { value: 0 };
  const springDamping: THREE.IUniform<number> = { value: 0 };

  const springMaterial = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uState: { value: springTargets[0].texture },
      uTrail: { value: bendTargets[0].texture },
      uDelta: springDelta,
      uStiffness: springStiffness,
      uDamping: springDamping,
    },
    vertexShader: DOF_VERTEX_SHADER,
    fragmentShader: BEND_SPRING_FRAGMENT_SHADER,
  });

  /** Longest step the explicit spring takes before it is split into substeps. */
  const SPRING_MAX_STEP = 1 / 60;

  const renderBend = (delta: number): void => {
    bendDecay.value = Math.exp(-delta / Math.max(bendRecovery.seconds, 0.01));
    quad.material = bendMaterial;
    bendMaterial.uniforms.uPrevious.value = bendTargets[bendSource].texture;
    renderer.setRenderTarget(bendTargets[1 - bendSource]);
    renderer.render(dofScene, dofCamera);
    bendSource = 1 - bendSource;

    const omega = 2 * Math.PI * Math.max(bendSpring.frequency, 0.01);
    springStiffness.value = omega * omega;
    springDamping.value = 2 * Math.max(bendSpring.damping, 0) * omega;
    const steps = Math.max(1, Math.min(Math.ceil(delta / SPRING_MAX_STEP), 6));
    springDelta.value = delta / steps;
    quad.material = springMaterial;
    springMaterial.uniforms.uTrail.value = bendTargets[bendSource].texture;
    for (let step = 0; step < steps; step++) {
      springMaterial.uniforms.uState.value = springTargets[springSource].texture;
      renderer.setRenderTarget(springTargets[1 - springSource]);
      renderer.render(dofScene, dofCamera);
      springSource = 1 - springSource;
    }
    grassUniforms.uBendMap.value = springTargets[springSource].texture;
  };

  /* ------------------------------------------------------- depth of field */

  // The scene renders here first. `depthTexture` is the point of the exercise:
  // the DOF pass reads the depth the normal pass already wrote, so it never has
  // to re-render the field with an override material.
  const renderTarget = new THREE.WebGLRenderTarget(1, 1, {
    depthBuffer: true,
    samples: byTier(tier, CONFIG.tiers.msaaSamples),
    // Half float because the buffer holds linear light: 8 bits of linear bands
    // visibly in the sky gradient and crushes everything in the shadows.
    type: THREE.HalfFloatType,
  });
  renderTarget.depthTexture = new THREE.DepthTexture(1, 1);
  renderTarget.depthTexture.format = THREE.DepthFormat;
  renderTarget.depthTexture.type = THREE.UnsignedIntType;
  // Left un-managed on purpose. three forces linear output into any render
  // target, so this buffer is linear light and the DOF pass does the sRGB
  // encode on the way to screen — tagging it here would double-convert.
  renderTarget.texture.colorSpace = THREE.NoColorSpace;
  renderTarget.texture.minFilter = THREE.LinearFilter;
  renderTarget.texture.magFilter = THREE.LinearFilter;

  const texelUniform: THREE.IUniform<THREE.Vector2> = {
    value: new THREE.Vector2(1, 1),
  };
  // Frame aspect, so the vignette's corner radius stays circular on screen
  // instead of stretching with the frame.
  const aspectUniform: THREE.IUniform<number> = { value: 1 };

  const dofMaterial = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uScene: { value: renderTarget.texture },
      uDepth: { value: renderTarget.depthTexture },
      uBloom: { value: null },
      uBloomIntensity: {
        value: CONFIG.bloom.intensity,
      } as THREE.IUniform<number>,
      uTexel: texelUniform,
      uNear: { value: cameraConfig.near },
      uFar: { value: cameraConfig.far },
      uFocusDistance: { value: CONFIG.dof.focusDistance },
      uNearRange: { value: CONFIG.dof.nearRange },
      uFarRange: { value: CONFIG.dof.farRange },
      uMaxNearBlur: { value: CONFIG.dof.maxNearBlur },
      uMaxFarBlur: { value: CONFIG.dof.maxFarBlur },
      uContrast: { value: CONFIG.grade.contrast },
      uSaturation: { value: CONFIG.grade.saturation },
      uLift: { value: CONFIG.grade.lift },
      uShadowTint: { value: new THREE.Color(CONFIG.grade.shadowTint) },
      uHighlightTint: { value: new THREE.Color(CONFIG.grade.highlightTint) },
      uTintStrength: { value: CONFIG.grade.tintStrength },
      uVignette: { value: CONFIG.grade.vignette },
      uVignetteRadius: { value: CONFIG.grade.vignetteRadius },
      uVignetteRoundness: { value: CONFIG.grade.vignetteRoundness },
      uVignetteSoftness: { value: CONFIG.grade.vignetteSoftness },
      uVignetteColor: { value: new THREE.Color(CONFIG.grade.vignetteColor) },
      uAspect: aspectUniform,
    },
    vertexShader: DOF_VERTEX_SHADER,
    fragmentShader: DOF_FRAGMENT_SHADER,
  });

  const dofGeometry = new THREE.PlaneGeometry(2, 2);
  // One quad and one camera, reused by every full-screen pass — the material is
  // swapped between them. The vertex shader writes clip space directly, so the
  // camera is only here because `render()` demands one.
  const quad = new THREE.Mesh(dofGeometry, dofMaterial);
  const dofScene = new THREE.Scene();
  dofScene.add(quad);
  const dofCamera = new THREE.Camera();

  /* ------------------------------------------------------------------ bloom */

  const makeBloomTarget = () =>
    new THREE.WebGLRenderTarget(1, 1, {
      depthBuffer: false,
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
    });
  const bloomTargets = [makeBloomTarget(), makeBloomTarget()];
  for (const target of bloomTargets) target.texture.colorSpace = THREE.NoColorSpace;

  const bloomBrightMaterial = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uScene: { value: renderTarget.texture },
      uThreshold: { value: CONFIG.bloom.threshold } as THREE.IUniform<number>,
      uKnee: { value: CONFIG.bloom.knee } as THREE.IUniform<number>,
    },
    vertexShader: DOF_VERTEX_SHADER,
    fragmentShader: BLOOM_BRIGHT_FRAGMENT_SHADER,
  });

  const bloomBlurDirection: THREE.IUniform<THREE.Vector2> = {
    value: new THREE.Vector2(),
  };
  const bloomBlurMaterial = new THREE.ShaderMaterial({
    depthTest: false,
    depthWrite: false,
    uniforms: {
      uSource: { value: bloomTargets[0].texture },
      uDirection: bloomBlurDirection,
    },
    vertexShader: DOF_VERTEX_SHADER,
    fragmentShader: BLOOM_BLUR_FRAGMENT_SHADER,
  });

  const bloomSpread: THREE.IUniform<number> = { value: CONFIG.bloom.spread };
  let bloomIterations = CONFIG.bloom.iterations;
  const bloomTexel = new THREE.Vector2(1, 1);

  /** Panel / config bloom strength, before the tier's scale is applied. */
  let bloomBaseIntensity: number = CONFIG.bloom.intensity;
  const applyBloomIntensity = (): void => {
    dofMaterial.uniforms.uBloomIntensity.value =
      bloomBaseIntensity * byTier(tier, CONFIG.tiers.bloomScale);
  };
  applyBloomIntensity();

  /** Bright pass, then widening horizontal/vertical blur pairs, ping-ponged. */
  const renderBloom = (): void => {
    // A zero-strength bloom would still run a full-screen chain every frame.
    if (dofMaterial.uniforms.uBloomIntensity.value <= 0.001) return;
    quad.material = bloomBrightMaterial;
    renderer.setRenderTarget(bloomTargets[0]);
    renderer.render(dofScene, dofCamera);

    quad.material = bloomBlurMaterial;
    let source = 0;
    const iterations = Math.min(bloomIterations, byTier(tier, CONFIG.tiers.bloomMaxIterations));
    for (let i = 0; i < iterations; i++) {
      // Each pair steps wider, so a handful of 9-tap passes reach much further
      // than their kernel — the cheap way to a glow that crosses the frame.
      const step = bloomSpread.value * Math.pow(2, i);
      for (const axis of [0, 1]) {
        bloomBlurDirection.value.set(
          axis === 0 ? bloomTexel.x * step : 0,
          axis === 1 ? bloomTexel.y * step : 0,
        );
        bloomBlurMaterial.uniforms.uSource.value = bloomTargets[source].texture;
        renderer.setRenderTarget(bloomTargets[1 - source]);
        renderer.render(dofScene, dofCamera);
        source = 1 - source;
      }
    }
    dofMaterial.uniforms.uBloom.value = bloomTargets[source].texture;
  };

  /* ------------------------------------------------------------------ frame */

  const clock = new THREE.Clock();

  const resize = (): void => {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (width === 0 || height === 0) return;

    const pixelRatio = clampedPixelRatio(tier);
    renderer.setPixelRatio(pixelRatio);
    particles.setPixelRatio(pixelRatio);
    particles.setViewport(width, height);
    // `false` — the canvas is CSS-sized, so three must not write style width/height.
    renderer.setSize(width, height, false);
    camera.aspect = width / height;
    camera.updateProjectionMatrix();
    aspectUniform.value = width / height;

    // The offscreen target carries the pixel ratio too. Clamping the renderer
    // but not the target throws the DPR saving straight back away.
    const bufferWidth = Math.round(width * pixelRatio);
    const bufferHeight = Math.round(height * pixelRatio);
    renderTarget.setSize(bufferWidth, bufferHeight);
    const bloomWidth = Math.max(
      1,
      Math.round(bufferWidth / CONFIG.bloom.downsample),
    );
    const bloomHeight = Math.max(
      1,
      Math.round(bufferHeight / CONFIG.bloom.downsample),
    );
    for (const target of bloomTargets) target.setSize(bloomWidth, bloomHeight);
    bloomTexel.set(1 / bloomWidth, 1 / bloomHeight);
    // Blur radii are authored in pixels at 1080p, so they scale with the buffer
    // rather than changing character between a laptop and a phone.
    const blurScale = bufferHeight / 1080;
    texelUniform.value.set(
      blurScale / bufferWidth,
      blurScale / bufferHeight,
    );
  };

  // The placed camera, kept so the sway is an offset from it rather than an
  // accumulation that drifts away over a long session.
  const basePosition = camera.position.clone();
  const baseQuaternion = camera.quaternion.clone();
  const swayScale: THREE.IUniform<number> = { value: 1 };

  // Clocks that are integrated rather than read off `elapsed`, so a gust can
  // speed them up and let them slow down again without the motion jumping.
  let windClock = 0;
  let skyClock = 0;
  let particleClock = 0;
  let gustStartedAt: number | null = null;
  const windGust: Record<keyof typeof CONFIG.windGust, number> = { ...CONFIG.windGust };

  /**
   * 0 → 1 over `attack` (smoothstep), then a Gaussian calm back to 0. Both
   * halves have zero slope where they meet, so the gust never visibly "turns".
   */
  const gustEnvelope = (elapsed: number): number => {
    if (gustStartedAt === null) return 0;
    const t = elapsed - gustStartedAt;
    const attack = Math.max(windGust.attack, 0.001);
    if (t < attack) {
      const s = t / attack;
      return s * s * (3 - 2 * s);
    }
    const u = (t - attack) / Math.max(windGust.calm, 0.01);
    if (u > 3) {
      gustStartedAt = null;
      return 0;
    }
    return Math.exp(-u * u);
  };

  const gust = (): void => {
    gustStartedAt = clock.elapsedTime;
  };

  // The bend and spring passes only matter while a dent exists. With the
  // pointer unbound (mobile) they are skipped once the last dent has had time
  // to recover and the springs to settle.
  let pointerEnabled = true;
  let bendQuietAt = 0;

  // Prewarm (skill §3): once every asset has settled, upload every texture and
  // compile every scene program in one go, while the preloader still owns the
  // screen — never lazily on the first frame that happens to need them.
  let prewarmState: "pending" | "running" | "done" = "pending";
  const prewarm = (): void => {
    prewarmState = "running";
    scene.traverse((object) => {
      const material = (object as THREE.Mesh).material;
      const materials = Array.isArray(material) ? material : material ? [material] : [];
      for (const entry of materials) {
        for (const value of Object.values(entry)) {
          if (value instanceof THREE.Texture) renderer.initTexture(value);
        }
        const uniforms = (entry as THREE.ShaderMaterial).uniforms;
        if (!uniforms) continue;
        for (const uniform of Object.values(uniforms)) {
          if (uniform.value instanceof THREE.Texture) renderer.initTexture(uniform.value);
        }
      }
    });
    // Compiled against the offscreen target the scene really renders into: a
    // program's variant depends on its target (linear output, no tone mapping
    // there), so compiling for the default framebuffer builds variants that
    // are never used and still leaves the real ones to compile on first draw.
    // The bend and spring passes are skipped on tiers without a pointer, so
    // they would otherwise first compile on a later tier switch — after the
    // loader. Draw them once now, whatever the tier.
    renderBend(1 / 60);
    renderer.setRenderTarget(renderTarget);
    // `compileAsync` (KHR_parallel_shader_compile where available) keeps the
    // preloader's counter moving; `compile` blocked the main thread ~115 ms.
    renderer
      .compileAsync(scene, camera)
      .catch(() => renderer.compile(scene, camera))
      .finally(() => {
        prewarmState = "done";
      });
    renderer.setRenderTarget(null);
  };

  const render = (): void => {
    if (!buildBlades()) {
      // Keep the clock honest while building, so the first real frame does not
      // receive the whole build time as its delta.
      clock.getDelta();
      return;
    }
    if (prewarmState === "pending" && pendingAssets <= 0) prewarm();
    if (prewarmState === "running") {
      clock.getDelta();
      return;
    }
    const assetsSettledAtFrameStart = pendingAssets <= 0;
    // Clamped hard: a tab-switch return would otherwise hand the scene a
    // multi-second delta and every integrated clock would jump.
    const delta = Math.min(clock.getDelta(), 0.05);
    const elapsed = clock.elapsedTime;
    // Two clocks on purpose. The grass runs quartered, because the wind noise is
    // sampled in the same units as world position and full-speed time makes the
    // field shimmer. The sky runs raw and scales itself down inside the shader.
    grassTimeUniform.value = (elapsed / 4) * CONFIG.windSpeed;
    const envelope = gustEnvelope(elapsed);
    const boost = (peak: number) => 1 + (peak - 1) * envelope;
    windClock += (delta / 4) * CONFIG.windSpeed * boost(windGust.speed);
    windTimeUniform.value = windClock;
    windStrengthUniform.value = boost(windGust.sway);
    windLeanUniform.value = windGust.lean * envelope;
    windWaveUniform.value = windGust.wave;
    skyClock += delta * boost(windGust.clouds);
    skyTimeUniform.value = skyClock;
    particleClock += delta * boost(windGust.particles);
    // Ease the pointer, then stamp the segment it travelled this frame. The
    // segment matters: at speed the cursor crosses metres between frames, and
    // stamping only its current position leaves a dotted trail of dents.
    bendFrom.value.copy(bendTo.value);
    if (pointerPresent) {
      // Exponential follow on real time, so the trail is equally lazy at 30 and
      // 144 fps. The old fixed per-frame lerp was close to instant at 60.
      const follow = Math.max(pointerFollow.seconds, 0.001);
      bendTo.value.lerp(mouseTarget, 1 - Math.exp(-delta / follow));
      bendActive.value = 1;
    } else {
      bendActive.value = 0;
    }
    if (bendFrom.value.x > pointer.parked * 0.5) bendFrom.value.copy(bendTo.value);

    tv.update(elapsed, pointerPresent ? pointerNdc : null, camera.position);
    particles.setTime(particleClock);
    tvPositionUniform.value.copy(tv.light.position);
    tvDirectionUniform.value.copy(tv.light.direction);
    tvFlickerUniform.value = tv.light.flicker;

    if (pointerPresent) bendQuietAt = elapsed + bendRecovery.seconds * 5 + 3;
    if (pointerEnabled || elapsed < bendQuietAt) renderBend(delta);

    // Handheld drift, applied to the placed camera each frame. Three sines at
    // unrelated periods, so the motion never visibly repeats.
    const swayPosition = CONFIG.camera.sway.positionAmplitude * swayScale.value;
    const swayRotation =
      THREE.MathUtils.degToRad(CONFIG.camera.sway.rotationDegrees) *
      swayScale.value;
    const swayTime = elapsed * CONFIG.camera.sway.speed;
    camera.position.set(
      basePosition.x + Math.sin(swayTime * 1.0) * swayPosition,
      basePosition.y + Math.sin(swayTime * 1.37 + 1.1) * swayPosition * 0.7,
      basePosition.z + Math.cos(swayTime * 0.83 + 2.3) * swayPosition,
    );
    camera.quaternion.copy(baseQuaternion);
    camera.rotateX(Math.sin(swayTime * 1.19 + 0.4) * swayRotation);
    camera.rotateY(Math.cos(swayTime * 0.91 + 1.7) * swayRotation);

    renderer.setRenderTarget(renderTarget);
    renderer.render(scene, camera);

    renderBloom();

    quad.material = dofMaterial;
    renderer.setRenderTarget(null);
    renderer.render(dofScene, dofCamera);

    // Reported after a finished frame that already had every asset in it.
    if (!readyReported && assetsSettledAtFrameStart) {
      readyReported = true;
      onReady?.();
    }
  };

  const dispose = (): void => {
    grassGeometry.dispose();
    grassMaterial.dispose();
    groundGeometry.dispose();
    groundMaterial.dispose();
    skyGeometry.dispose();
    skyMaterial.dispose();
    grassTexture.dispose();
    alphaMap.dispose();
    tv.dispose();
    particles.dispose();
    bendMaterial.dispose();
    for (const target of bendTargets) target.dispose();
    springMaterial.dispose();
    for (const target of springTargets) target.dispose();
    keyLight.dispose();
    fillLight.dispose();
    shadow.dispose();
    bloomBrightMaterial.dispose();
    bloomBlurMaterial.dispose();
    for (const target of bloomTargets) target.dispose();
    dofGeometry.dispose();
    dofMaterial.dispose();
    renderTarget.depthTexture.dispose();
    renderTarget.dispose();
    dofScene.clear();
    scene.clear();
    renderer.dispose();
  };

  /* -------------------------------------------------------- colour registry */

  interface ColorBinding {
    label: string;
    group: string;
    path: string;
    uniform: THREE.IUniform<THREE.Color>;
    /** The shader reads this uniform as linear light. */
    linear: boolean;
    initial: string;
  }

  const colorBindings = new Map<string, ColorBinding>();
  const bindColor = (
    key: string,
    label: string,
    group: string,
    path: string,
    uniform: THREE.IUniform<THREE.Color>,
    initial: string,
    linear = false,
  ): void => {
    colorBindings.set(key, { label, group, path, uniform, linear, initial });
  };

  bindColor("tip", "Blade tip", "Grass", "colors.tip", grassUniforms.tipColor, colors.tip);
  bindColor("bottom", "Blade root", "Grass", "colors.bottom", grassUniforms.bottomColor, colors.bottom);
  bindColor("dry", "Dry blades", "Grass", "colors.dry", grassUniforms.uDryColor, colors.dry);
  bindColor("flower", "Flowers", "Grass", "colors.flower", grassUniforms.uFlowerColor, colors.flower);
  bindColor("groundBase", "Ground base", "Grass", "colors.groundBase",
    groundMaterial.uniforms.uBaseColor as THREE.IUniform<THREE.Color>, colors.groundBase);
  bindColor("groundTip", "Ground tint", "Grass", "colors.groundTip",
    groundMaterial.uniforms.uTipColor as THREE.IUniform<THREE.Color>, colors.groundTip);

  bindColor("sun", "Sun", "Light", "colors.sun", grassUniforms.uSunColor, colors.sun);
  bindColor("skyLight", "Sky light", "Light", "colors.skyLight", grassUniforms.uSkyColor, colors.skyLight);
  bindColor("haze", "Aerial haze", "Light", "colors.haze", fogColorUniform, colors.haze, true);

  bindColor("skyTop", "Zenith", "Sky", "colors.skyTop", skyUniforms.uTop, colors.skyTop, true);
  bindColor("skyHorizon", "Horizon", "Sky", "colors.skyHorizon", skyUniforms.uHorizon, colors.skyHorizon, true);
  bindColor("horizonGlow", "Horizon glow", "Sky", "colors.horizonGlow", skyUniforms.uHorizonGlow, colors.horizonGlow, true);
  bindColor("cloud", "Clouds", "Sky", "colors.cloud", skyUniforms.uCloudColor, colors.cloud, true);

  bindColor("tvLight", "Screen light", "Television", "tv.light.color",
    tvLightUniforms.uTvColor, CONFIG.tv.light.color);
  bindColor("tvCore", "Screen core", "Television", "tv.screen.coreColor",
    tv.screenUniforms.uCore, CONFIG.tv.screen.coreColor);
  bindColor("tvEdge", "Screen edge", "Television", "tv.screen.edgeColor",
    tv.screenUniforms.uEdge, CONFIG.tv.screen.edgeColor);

  // The grade's split-tone was the other colour pair the panel could not reach,
  // so it could never appear in a copied config either — and it tints the whole
  // frame. Display-space, hence not flagged linear.
  bindColor("particleColor", "Motes", "Particles", "particles.color",
    particles.uniforms.uColor, CONFIG.particles.color);
  bindColor("vignetteColor", "Vignette", "Grade", "grade.vignetteColor",
    dofMaterial.uniforms.uVignetteColor as THREE.IUniform<THREE.Color>,
    CONFIG.grade.vignetteColor);
  bindColor("shadowTint", "Shadow tint", "Grade", "grade.shadowTint",
    dofMaterial.uniforms.uShadowTint as THREE.IUniform<THREE.Color>,
    CONFIG.grade.shadowTint);
  bindColor("highlightTint", "Highlight tint", "Grade", "grade.highlightTint",
    dofMaterial.uniforms.uHighlightTint as THREE.IUniform<THREE.Color>,
    CONFIG.grade.highlightTint);

  const colorControls: SceneColorControl[] = [...colorBindings].map(
    ([key, binding]) => ({
      key,
      label: binding.label,
      group: binding.group,
      path: binding.path,
      value: binding.initial,
    }),
  );

  /* -------------------------------------------------------- number registry */

  const numberSetters = new Map<string, (value: number) => void>();
  const numberControls: SceneNumberControl[] = [];
  const bindNumber = (
    key: string,
    label: string,
    group: string,
    path: string,
    value: number,
    range: [number, number, number],
    apply: (value: number) => void,
  ): void => {
    const [min, max, step] = range;
    numberControls.push({ key, label, group, path, value, min, max, step });
    numberSetters.set(key, apply);
  };

  const dof = dofMaterial.uniforms;
  bindNumber("focusDistance", "Focus distance", "Depth of field", "dof.focusDistance",
    CONFIG.dof.focusDistance, [2, 80, 0.5], (v) => (dof.uFocusDistance.value = v));
  bindNumber("nearRange", "Near range", "Depth of field", "dof.nearRange",
    CONFIG.dof.nearRange, [1, 60, 0.5], (v) => (dof.uNearRange.value = v));
  bindNumber("maxNearBlur", "Near blur", "Depth of field", "dof.maxNearBlur",
    CONFIG.dof.maxNearBlur, [0, 40, 0.5], (v) => (dof.uMaxNearBlur.value = v));
  bindNumber("farRange", "Far range", "Depth of field", "dof.farRange",
    CONFIG.dof.farRange, [5, 200, 1], (v) => (dof.uFarRange.value = v));
  bindNumber("maxFarBlur", "Far blur", "Depth of field", "dof.maxFarBlur",
    CONFIG.dof.maxFarBlur, [0, 25, 0.5], (v) => (dof.uMaxFarBlur.value = v));

  // Not a uniform — a renderer property. Still live and still free to set, which
  // is the registry's actual test, and it is the one control that answers
  // "the whole thing is too dark" directly instead of by proxy.
  bindNumber("exposure", "Exposure", "Grade", "renderer.toneMappingExposure",
    CONFIG.renderer.toneMappingExposure, [0.2, 2.5, 0.01],
    (v) => (renderer.toneMappingExposure = v));
  bindNumber("vignette", "Vignette amount", "Grade", "grade.vignette",
    CONFIG.grade.vignette, [0, 1, 0.01], (v) => (dof.uVignette.value = v));
  bindNumber("vignetteRadius", "Vignette radius", "Grade", "grade.vignetteRadius",
    CONFIG.grade.vignetteRadius, [0, 1.2, 0.01], (v) => (dof.uVignetteRadius.value = v));
  bindNumber("vignetteRoundness", "Vignette roundness", "Grade", "grade.vignetteRoundness",
    CONFIG.grade.vignetteRoundness, [0, 1, 0.01], (v) => (dof.uVignetteRoundness.value = v));
  bindNumber("vignetteSoftness", "Vignette softness", "Grade", "grade.vignetteSoftness",
    CONFIG.grade.vignetteSoftness, [0.01, 0.8, 0.005], (v) => (dof.uVignetteSoftness.value = v));
  bindNumber("contrast", "Contrast", "Grade", "grade.contrast",
    CONFIG.grade.contrast, [0.5, 2, 0.01], (v) => (dof.uContrast.value = v));
  bindNumber("saturation", "Saturation", "Grade", "grade.saturation",
    CONFIG.grade.saturation, [0, 2.5, 0.01], (v) => (dof.uSaturation.value = v));
  bindNumber("tintStrength", "Split tone", "Grade", "grade.tintStrength",
    CONFIG.grade.tintStrength, [0, 0.6, 0.005], (v) => (dof.uTintStrength.value = v));
  bindNumber("lift", "Lift", "Grade", "grade.lift",
    CONFIG.grade.lift, [-0.15, 0.15, 0.005], (v) => (dof.uLift.value = v));

  bindNumber("tvIntensity", "Light intensity", "Television", "tv.light.intensity",
    CONFIG.tv.light.intensity, [0, 60, 0.5], (v) => (tvLightUniforms.uTvIntensity.value = v));
  bindNumber("tvRadius", "Light radius", "Television", "tv.light.radius",
    CONFIG.tv.light.radius, [2, 90, 1], (v) => (tvLightUniforms.uTvRadius.value = v));
  bindNumber("tvFocus", "Light focus", "Television", "tv.light.focus",
    CONFIG.tv.light.focus, [0.05, 4, 0.05], (v) => (tvLightUniforms.uTvFocus.value = v));
  bindNumber("tvSun", "Cabinet sun", "Television", "tv.lighting.sun",
    CONFIG.tv.lighting.sun, [0, 6, 0.05], (v) => (keyLight.intensity = v));
  bindNumber("tvSky", "Cabinet sky", "Television", "tv.lighting.sky",
    CONFIG.tv.lighting.sky, [0, 6, 0.05], (v) => (fillLight.intensity = v));
  bindNumber("screenIntensity", "Screen brightness", "Television", "tv.screen.intensity",
    CONFIG.tv.screen.intensity, [0, 30, 0.25], (v) => (tv.screenUniforms.uIntensity.value = v));
  bindNumber("pointerRadius", "Dent radius", "Pointer", "pointer.radius",
    CONFIG.pointer.radius, [1, 30, 0.5],
    (v) => (bendMaterial.uniforms.uRadius.value = v));
  bindNumber("pointerStrength", "Dent depth", "Pointer", "pointer.strength",
    CONFIG.pointer.strength, [0, 3, 0.01],
    (v) => (grassUniforms.uMouseStrength.value = v));
  bindNumber("pointerRecovery", "Recovery seconds", "Pointer", "pointer.recovery",
    CONFIG.pointer.recovery, [0.05, 8, 0.05], (v) => (bendRecovery.seconds = v));
  bindNumber("pointerReference", "Far boost from", "Pointer", "pointer.distanceReference",
    CONFIG.pointer.distanceReference, [1, 60, 0.5],
    (v) => (grassUniforms.uBendReference.value = v));
  bindNumber("pointerFarRadius", "Far radius x", "Pointer", "pointer.farRadius",
    CONFIG.pointer.farRadius, [1, 8, 0.1],
    (v) => (bendMaterial.uniforms.uFarRadius.value = v));
  bindNumber("pointerFarStrength", "Far depth x", "Pointer", "pointer.farStrength",
    CONFIG.pointer.farStrength, [1, 8, 0.1],
    (v) => (grassUniforms.uBendFarStrength.value = v));
  bindNumber("pointerFollow", "Trail lag seconds", "Pointer", "pointer.follow",
    CONFIG.pointer.follow, [0, 0.6, 0.01], (v) => (pointerFollow.seconds = v));
  bindNumber("pointerSpringFrequency", "Blade inertia Hz", "Pointer", "pointer.spring.frequency",
    CONFIG.pointer.spring.frequency, [0.2, 5, 0.05], (v) => (bendSpring.frequency = v));
  bindNumber("pointerSpringDamping", "Blade damping", "Pointer", "pointer.spring.damping",
    CONFIG.pointer.spring.damping, [0.05, 1.5, 0.01], (v) => (bendSpring.damping = v));
  bindNumber("cameraSway", "Camera sway", "Camera", "camera.sway.positionAmplitude",
    CONFIG.camera.sway.positionAmplitude, [0, 1, 0.01],
    (v) => (swayScale.value = v / Math.max(CONFIG.camera.sway.positionAmplitude, 1e-4)));

  bindNumber("cloudCover", "Cloud cover", "Sky", "sky.cloudCover",
    CONFIG.sky.cloudCover, [0, 1, 0.01], (v) => (skyUniforms.uCloudCover.value = v));
  bindNumber("cloudOpacity", "Cloud opacity", "Sky", "sky.cloudOpacity",
    CONFIG.sky.cloudOpacity, [0, 1, 0.01], (v) => (skyUniforms.uCloudOpacity.value = v));
  bindNumber("cloudBrightness", "Cloud brightness cap", "Sky", "sky.cloudBrightness",
    CONFIG.sky.cloudBrightness, [0.2, 1.5, 0.01], (v) => (skyUniforms.uCloudBrightness.value = v));
  bindNumber("cloudGateLow", "Cloud spread (low)", "Sky", "sky.cloudGateLow",
    CONFIG.sky.cloudGateLow, [-0.4, 0.8, 0.01], (v) => (skyUniforms.uCloudGate.value.x = v));
  bindNumber("cloudGateHigh", "Cloud spread (high)", "Sky", "sky.cloudGateHigh",
    CONFIG.sky.cloudGateHigh, [0, 1.2, 0.01], (v) => (skyUniforms.uCloudGate.value.y = v));
  bindNumber("gustLean", "Gust lean", "Wind", "windGust.lean",
    CONFIG.windGust.lean, [0, 0.5, 0.01], (v) => (windGust.lean = v));
  bindNumber("gustWave", "Gust wave", "Wind", "windGust.wave",
    CONFIG.windGust.wave, [0, 1, 0.01], (v) => (windGust.wave = v));
  bindNumber("gustSway", "Gust sway", "Wind", "windGust.sway",
    CONFIG.windGust.sway, [1, 3, 0.05], (v) => (windGust.sway = v));
  bindNumber("gustSpeed", "Gust ripple speed", "Wind", "windGust.speed",
    CONFIG.windGust.speed, [1, 5, 0.05], (v) => (windGust.speed = v));
  bindNumber("gustAttack", "Gust rise seconds", "Wind", "windGust.attack",
    CONFIG.windGust.attack, [0.1, 4, 0.05], (v) => (windGust.attack = v));
  bindNumber("gustCalm", "Gust calm seconds", "Wind", "windGust.calm",
    CONFIG.windGust.calm, [0.2, 6, 0.05], (v) => (windGust.calm = v));

  bindNumber("particleBrightness", "Brightness", "Particles", "particles.brightness",
    CONFIG.particles.brightness, [0, 8, 0.05],
    (v) => (particles.uniforms.uBrightness.value = v));
  bindNumber("particleSize", "Size", "Particles", "particles.size",
    CONFIG.particles.size, [2, 120, 1], (v) => (particles.uniforms.uSize.value = v));
  bindNumber("particleSpeed", "Wander speed", "Particles", "particles.speed",
    CONFIG.particles.speed, [0, 3, 0.01], (v) => (particles.uniforms.uSpeed.value = v));
  bindNumber("particleDrift", "Wander reach", "Particles", "particles.drift",
    CONFIG.particles.drift, [0, 8, 0.05], (v) => (particles.uniforms.uDrift.value = v));
  bindNumber("particleRise", "Rise speed", "Particles", "particles.rise",
    CONFIG.particles.rise, [0, 4, 0.01], (v) => (particles.uniforms.uRise.value = v));
  bindNumber("particleTwinkle", "Twinkle", "Particles", "particles.twinkle",
    CONFIG.particles.twinkle, [0, 1, 0.01], (v) => (particles.uniforms.uTwinkle.value = v));
  bindNumber("particleTwinkleSpeed", "Twinkle speed", "Particles", "particles.twinkleSpeed",
    CONFIG.particles.twinkleSpeed, [0.1, 6, 0.05],
    (v) => (particles.uniforms.uTwinkleSpeed.value = v));

  bindNumber("screenEdgeStart", "Picture edge", "Television", "tv.screen.edgeStart",
    CONFIG.tv.screen.edgeStart, [0, 1, 0.01],
    (v) => (tv.screenUniforms.uEdgeStart.value = v));
  bindNumber("screenCentreLift", "Picture centre lift", "Television", "tv.screen.centreLift",
    CONFIG.tv.screen.centreLift, [0, 1, 0.01],
    (v) => (tv.screenUniforms.uCentreLift.value = v));

  bindNumber("bloomIntensity", "Bloom strength", "Bloom", "bloom.intensity",
    CONFIG.bloom.intensity, [0, 4, 0.05],
    (v) => {
      bloomBaseIntensity = v;
      applyBloomIntensity();
    });
  bindNumber("bloomThreshold", "Bloom threshold", "Bloom", "bloom.threshold",
    CONFIG.bloom.threshold, [0, 6, 0.05],
    (v) => (bloomBrightMaterial.uniforms.uThreshold.value = v));
  bindNumber("bloomKnee", "Bloom knee", "Bloom", "bloom.knee",
    CONFIG.bloom.knee, [0.01, 3, 0.01],
    (v) => (bloomBrightMaterial.uniforms.uKnee.value = v));
  bindNumber("bloomSpread", "Bloom spread", "Bloom", "bloom.spread",
    CONFIG.bloom.spread, [0.2, 5, 0.05], (v) => (bloomSpread.value = v));
  bindNumber("bloomIterations", "Bloom passes", "Bloom", "bloom.iterations",
    CONFIG.bloom.iterations, [1, 7, 1], (v) => (bloomIterations = Math.round(v)));

  const setNumber = (key: string, value: number): void => {
    numberSetters.get(key)?.(value);
  };

  const setColor = (key: string, hex: string): void => {
    const binding = colorBindings.get(key);
    if (!binding) return;
    binding.uniform.value.set(hex);
    if (binding.linear) binding.uniform.value.convertSRGBToLinear();
  };

  const retune = (nextTier: DeviceTier): void => {
    tier = nextTier;
    if (bladesBuilt >= total) {
      grassGeometry.instanceCount = byTier(tier, CONFIG.tiers.instances);
    }
    particles.setCount(byTier(tier, CONFIG.tiers.particles));
    const samples = byTier(tier, CONFIG.tiers.msaaSamples);
    if (renderTarget.samples !== samples) {
      // A different sample count needs a new framebuffer, not a new program.
      renderTarget.dispose();
      renderTarget.samples = samples;
    }
    applyBloomIntensity();
    pointerEnabled = tier !== "mobile";
    if (!pointerEnabled) parkPointer();
    resize();
  };

  retune(tier);

  return {
    render,
    resize,
    setPointer,
    parkPointer,
    gust,
    retune,
    dispose,
    colorControls,
    setColor,
    numberControls,
    setNumber,
  };
};

// 📖 Docs: obsidian/frontend/components/scene.md

/**
 * Grass field scene configuration.
 *
 * Every tunable the scene reads lives here as a named constant — the scene
 * modules never inline a literal (hard rule #4, and the "tier constants belong
 * in the scene module" clause of obsidian/workflows/optimize-3d-scene.md).
 *
 * The colours below are **shader/material inputs**, not UI styles: they are fed
 * to `THREE.Color` uniforms inside a WebGL program, never to a `className`.
 * Design tokens in `globals.css` cannot reach a GLSL uniform, so this file is
 * their single source of truth. The one exception is `--scene-backdrop`, the
 * CSS token painted behind the canvas before the first frame — it mirrors
 * `colors.skyHorizon` on purpose; keep the two in sync.
 */

/** Fixed PRNG seed — pins terrain relief *and* blade layout, so the meadow is identical on every load. */
export const GRASS_FIELD_SEED = 2241217164;

export const GRASS_FIELD_CONFIG = {
  /**
   * Blade buffer size, drawn in a single instanced call. This is the largest
   * tier's count; smaller tiers draw a prefix of it (`tiers.instances`).
   */
  instances: 280_000,
  /**
   * Per-device budgets, read through `src/lib/scene/device.ts` (ADR-0042).
   * Buffers are always allocated for the largest tier, so a tier change mid-
   * session is an integer write — never a rebuild, never a recompile.
   */
  tiers: {
    /**
     * Blades drawn. Every blade's position is an independent draw from the
     * scatter, so the first N are a uniform sample of the field — truncating
     * thins it evenly rather than deleting a region.
     */
    instances: { desktop: 280_000, tablet: 190_000, mobile: 110_000 },
    /** Motes drawn, via `setDrawRange` on a buffer sized for `particles.count`. */
    particles: { desktop: 600, tablet: 400, mobile: 180 },
    /**
     * MSAA on the offscreen scene target. Not zero on mobile: the blades are
     * hair-thin and shimmer badly without it, even at DPR 1.
     */
    msaaSamples: { desktop: 4, tablet: 4, mobile: 2 },
    /** Bloom strength multiplier. */
    bloomScale: { desktop: 1, tablet: 1, mobile: 0.6 },
    /** Ceiling on blur pairs, whatever `bloom.iterations` asks for. */
    bloomMaxIterations: { desktop: 7, tablet: 5, mobile: 3 },
    /**
     * Largest TV texture edge uploaded, px. Read at construction only: a map
     * already downscaled cannot be restored without re-fetching the model.
     */
    maxTextureSize: { desktop: 1024, tablet: 512, mobile: 512 },
  },
  /**
   * Blades are scattered on a disc centred under the camera, not on a square.
   *
   * A square field has to end somewhere, and at this eye height its far edge
   * lands in frame as a line where grass stops and bare ground starts. A disc
   * reaching past the visible horizon has no edge to see.
   *
   * `fieldDensityBias` is the exponent in `r = radius * random^bias`, and the
   * direction is the opposite of what it looks like: **higher concentrates
   * blades near the camera.** The fraction landing within distance d is
   * `(d/radius)^(1/bias)`, so 0.5 is uniform density per unit area and anything
   * above it crowds the foreground. This was set to 0.58 — near-uniform by area
   * — which spent most of the budget on distance, where a blade is sub-pixel:
   * of 420,000 blades only ~9,900 fell within ten metres of the eye — a bald
   * foreground. At 1.75 with a 78-unit disc, 480,000 blades put ~148,000 in that
   * same ten metres, fifteen times as many.
   *
   * Aspect ratio matters here in a way it does not elsewhere: the vertical FOV
   * is fixed, so a wide viewport widens the *ground* in frame without adding any
   * height, and the near field has to cover far more of it. A density that looks
   * full at 16:9 thins out visibly on an ultrawide.
   */
  fieldRadius: 78,
  /**
   * Was 1.75, which packed ~30% of all blades into the first ten metres and left
   * the mid-distance hills under the television thin enough to show bare ground.
   * Once the scatter was limited to the camera's arc (`fieldArcDegrees`), every
   * blade landed in frame, so the bias could come down. The near field is still
   * denser than it was, and the 20-45 unit hills are ~4x denser.
   */
  fieldDensityBias: 1.3,
  /**
   * Width of the wedge, centred on the camera heading, that blades are scattered
   * in. The camera never turns, so blades outside its horizontal field of view
   * are never seen, and a full disc wasted ~3/4 of the instance budget behind
   * and beside the lens. 115 degrees covers the frustum at a 32:9 viewport
   * (half-angle ~51 degrees with the 38 degree vertical FOV) plus a margin for
   * the sway and the look-at toward the television. Widen it if a wider aspect
   * or a turning camera is ever supported.
   */
  fieldArcDegrees: 115,
  /**
   * The ground mesh runs well past the blades so the relief keeps going to the
   * horizon instead of ending at a visible edge. Fog does the rest of the work.
   */
  groundWidth: 420,
  groundSegments: 220,

  /**
   * `width` is a quarter of the pmndrs original's 0.12: fat blades read as
   * macaroni from this locked camera, so the blades are thinned to hair and the
   * instance count raised ~4x to keep the lawn dense.
   */
  blade: { width: 0.042, height: 0.5, joints: 5 },

  /**
   * Blade height variation. Real grass is not uniformly random: it grows in
   * patches, and within a patch most blades sit near one height with a few
   * running away above them.
   *
   * `clumpScale` is the size of those patches in world units; `clumpAmount` how
   * far a patch departs from the mean. `skew` shapes the within-patch
   * distribution — above 1 it pushes the mass toward short, so tall blades read
   * as occasional stragglers instead of half the field.
   */
  height: {
    clumpScale: 7,
    clumpAmount: 0.42,
    minStretch: 0.15,
    maxStretch: 1.55,
    skew: 1.9,
  },

  /**
   * The floating television.
   *
   * Placed along the camera's own view direction, and on the highest ground
   * found between `searchRange` metres down that ray — not at a fixed distance.
   * The relief is noise, so a fixed distance lands wherever it happens to land:
   * the first attempt at 23 m dropped the set into a hollow six metres below the
   * eye, behind a rise that occluded it completely. Searching for the crest puts
   * it against the sky, and keeps doing so if the terrain or the camera moves.
   *
   * `lateral` is metres right of the ray, `hover` is height above the ground it
   * settles over.
   */
  tv: {
    /** Authored Z-up with the screen facing -X; the loader yaws it to face +Z. */
    modelUrl: "/assets/grass-hero/tv.glb",
    /** Draco decoder, vendored from the three package — never a CDN. */
    dracoDecoderPath: "/draco/",
    /** Material name of the glass inside the model — the picture is drawn on it. */
    screenMaterialName: "screen",
    /**
     * The model arrives with standard materials, so unlike everything else in
     * this scene it needs actual lights. These two exist for it alone — nothing
     * else in the graph reads a light.
     */
    lighting: { sun: 2.2, sky: 1.1 },
    /** Cabinet width in world units; the model is scaled to match. */
    width: 7.2,
    searchRange: [18, 44],
    lateral: 1.5,
    hover: 3.8,
    scale: 2.4,
    /** Slow vertical drift, and a slow roll — it is floating, not hovering rigidly. */
    bobAmplitude: 0.3,
    bobSpeed: 0.5,
    swayDegrees: 6,
    swaySpeed: 0.33,
    /**
     * Resting attitude when the pointer is away. Both are **relative to facing
     * the camera**, as are the limits below: the set turns on every axis but is
     * never allowed to show its back, because the screen is both the light
     * source and the subject.
     */
    tiltDegrees: -12,
    yawDegrees: -16,
    /** Per-frame easing toward where the cursor is — lower is heavier. */
    followRate: 0.05,
    /**
     * How far the cursor nudges the set off its rest attitude, in degrees at the
     * edge of the frame. These *are* the limits — the nudge is bounded by its own
     * amplitude, so the set cannot turn its back however far the cursor goes.
     */
    follow: { yaw: 26, pitch: 18, roll: 14 },

    screen: {
      /** Hot core and the colour the picture falls off into. */
      coreColor: "#fffdf2",
      edgeColor: "#ff9a30",
      intensity: 13.75,
      /** Amplitude of the CRT's unsteadiness, 0 = rock steady. */
      flicker: 0.07,
      /**
       * Where the picture starts fading toward the rim of the glass, 0..1. Near
       * 1 the whole panel is lit right to its edge; lower and it retreats into
       * the middle. Not a radial falloff — that lights an oval and leaves the
       * corners dark, which reads as a blob inside the cabinet.
       */
      edgeStart: 0.86,
      /** How much brighter the middle of the picture is than its edges. */
      centreLift: 0.55,
    },
    light: {
      color: "#ff8a2a",
      intensity: 0,
      /** Metres at which the screen's light has fallen to a quarter. */
      radius: 11,
      /**
       * How much the light is confined to the direction the screen faces.
       * Below 1 — i.e. broader than a Lambertian emitter — on purpose: at 1.5
       * the cone pointed at the camera and the grass directly beneath the set,
       * which is the whole point of the effect, got almost nothing.
       */
      focus: 0.05,
    },
  },

  /**
   * Drifting motes over the field.
   *
   * `count` is the one setting the panel cannot touch — it sizes the buffers, so
   * changing it needs a rebuild. Everything else is a uniform.
   */
  particles: {
    count: 600,
    color: "#eec496",
    /** Point size in pixels at 60 units away; attenuates with distance. */
    size: 4,
    /** Well above 1 so the motes clear the bloom threshold and glow. */
    brightness: 2.2,
    /** Disc radius and band height around the camera, in world units. */
    radius: 70,
    height: 26,
    /** Lateral wander speed and reach. */
    speed: 0.45,
    drift: 2.25,
    /** How fast the band scrolls upward. */
    rise: 0.55,
    /** 0 = steady, 1 = fully pulsing. */
    twinkle: 0,
    twinkleSpeed: 0.6,
    /**
     * `size` is in pixels, so on a smaller canvas each mote covered more of the
     * frame. Below this viewport the size scales with
     * `min(width / w, height / h)` — the design frame, the same one the UI's rem
     * grid is built on. Never scaled up past 1, so large screens look as tuned.
     */
    referenceViewport: { width: 1440, height: 800 },
    /** Floor for that scale, so motes stay visible on a phone. */
    minViewportScale: 0.4,
  },

  /**
   * Bloom.
   *
   * A real one: bright pixels are extracted from the scene buffer, blurred at
   * reduced resolution and added back before the grade. The additive quad this
   * replaces could only ever glow *around* the set — light that has been blurred
   * across the frame buffer washes over the bezel, so the screen's own edge
   * dissolves, which is what the reference does and what a quad cannot.
   *
   * `threshold` is in linear light: the screen is `toneMapped: false` and sits
   * well above 1, so it blooms hard while the lit grass barely does.
   */
  bloom: {
    threshold: 1.8,
    knee: 0.6,
    intensity: 0.2,
    /** Frame-buffer divisor for the blur. Higher is softer and cheaper. */
    downsample: 4,
    /** Horizontal+vertical blur pairs. Each one roughly doubles the spread. */
    iterations: 4 as number,
    /** Texel step of the first blur pair; later pairs widen from it. */
    spread: 0.6,
  },

  /**
   * Final colour grade, applied in display space at the end of the composite
   * pass. Deliberately not a neutral look: the brief is punchy and unnatural,
   * and the split-tone is what sells it — shadows pushed to the sky's blue, the
   * highlights to the screen's orange, so the two light sources read as two
   * different colours of light rather than as one with a tint.
   */
  grade: {
    contrast: 1.13,
    saturation: 1.05,
    lift: 0.01,
    shadowTint: "#4d4030",
    highlightTint: "#eab079",
    tintStrength: 0.6,
    /**
     * Edge darkening, shaped as a rounded rectangle rather than an ellipse — an
     * ellipse inscribed in the frame bites deepest at the middle of each edge
     * and leaves the corners brightest, which is backwards.
     *
     * `vignette` is how far it goes toward `vignetteColor` at full falloff,
     * `vignetteRadius` is the fraction of the frame the untouched plateau
     * covers, `vignetteRoundness` is corner rounding (0 = square corners,
     * 1 = fully round), and `vignetteSoftness` is the width of the ramp in
     * height-relative units.
     */
    vignette: 1,
    vignetteRadius: 0.74,
    vignetteRoundness: 0.7,
    vignetteSoftness: 0.43,
    vignetteColor: "#000000",
  },

  /** Multiplies the base wind clock (`elapsed / 4`). */
  windSpeed: 1,
  /**
   * The gust that sweeps the field when the page is revealed (`scene.gust()`).
   *
   * Strong wind reads as the *whole field leaning one way*, with broad waves
   * rolling through it — not as every blade thrashing faster. The first version
   * multiplied the per-blade noise (×2.3 amplitude, ×4 speed) and looked like
   * static. So the gust is mostly `lean`: a shared bend in the wind's direction,
   * modulated by a long travelling wave, with the noise only nudged.
   *
   * The envelope is smooth at both ends: a smoothstep rise over `attack`, then a
   * Gaussian fall (`exp(-(t/calm)²)`) with zero slope at the peak, so there is
   * no corner where the rise turns into the calm.
   */
  windGust: {
    /**
     * Extra bend at the peak, as a quaternion half-angle in radians, on top of
     * the calm sway. 0.28 is roughly a 32° lean. Past ~0.4 the tips meet the
     * ground when the noise peaks too.
     */
    lean: 0.28,
    /** How much the broad wave modulates the lean: 0 is a flat push, 1 fully pulses. */
    wave: 0.45,
    /** Per-blade sway amplitude multiplier — kept small; this is what reads as jitter. */
    sway: 1.2,
    /** Wind-noise speed multiplier — kept small for the same reason. */
    speed: 1.5,
    /** Mote wander and rise. */
    particles: 2,
    /** Cloud drift. */
    clouds: 3,
    /** Seconds to reach full strength. */
    attack: 1.1,
    /** Seconds for the Gaussian calm to fall to ~37 %; settled by ~2.5 × this. */
    calm: 2.2,
  },

  pointer: {
    /**
     * The cursor's dent in the field, written into a decaying map rather than
     * applied straight from the pointer position — see `BEND_STAMP_FRAGMENT_SHADER`.
     * Without the map a blade is upright again the frame the pointer leaves it,
     * and a fast sweep heals behind the cursor as fast as it is drawn.
     */
    /** World-unit radius of the dent the pointer presses. */
    radius: 7,
    /** How far a fully dented blade bows, in world units at the tip. */
    strength: 0.5,
    /**
     * Seconds for a dent to fade to ~37% of its depth. Higher is a field that
     * stays trampled longer; this is the recovery the old version had none of.
     */
    recovery: 1.1,
    /**
     * Distance compensation. `radius` and `strength` are world units, so the
     * same dent that fills the near hill shrinks to a few pixels on the hills
     * under the television, 20-40 units out. Past `distanceReference` both grow
     * linearly with distance from the camera, which keeps the dent roughly the
     * same size on screen, up to the `far*` multipliers.
     */
    distanceReference: 10,
    /** Largest multiplier `radius` reaches with distance. */
    farRadius: 1.75,
    /** Largest multiplier `strength` reaches with distance. */
    farStrength: 3,
    /** Texels per side of the bend map. */
    resolution: 512,
    /**
     * Seconds for the stamped pointer to close ~63% of the gap to the real
     * cursor. Frame-rate independent. Higher is a lazier trail that rounds off
     * jerky mouse movement before it ever reaches the grass.
     */
    follow: 0.12,
    /**
     * Blade inertia. The blades do not take the trampled pose directly: every
     * texel of the field is a damped spring chasing it, so a dent builds up
     * behind the cursor, and when it recovers the blades swing back past upright
     * and settle. See `BEND_SPRING_FRAGMENT_SHADER`.
     */
    spring: {
      /** Natural frequency, Hz. Lower is heavier, slower blades. */
      frequency: 1.1,
      /** Damping ratio. 1 settles without overshoot; lower wobbles longer. */
      damping: 0.5,
    },
    /** Parking coordinate, far off the field: breeze absent rather than flagged off. */
    parked: 1e6,
  },

  camera: {
    fov: 38,
    near: 0.1,
    far: 2000,
    /** Standing point. Chosen by scanning the seeded relief, not by eye. */
    x: -30,
    z: -15,
    /** Eye height above the ground beneath it — blades reach ~2.8, so this looks over the canopy. */
    eyeHeight: 1.3,
    /** Compass heading, degrees: 0 looks down -Z, 90 looks down +X. */
    yawDeg: 16,
    /**
     * Pitch, degrees, negative looking down. Aim is expressed as an angle rather
     * than as a point on the ground: a ground-relative target silently tilts the
     * camera up whenever it sits on higher ground than the eye, which throws the
     * near grass out of frame and takes the foreground bokeh with it.
     */
    pitchDeg: -2,
    /**
     * Handheld drift. The camera is no longer strictly locked — it is placed
     * once and then offset by a few centimetres and a fraction of a degree from
     * layered sines, which reads as a held shot rather than a tripod.
     */
    sway: {
      positionAmplitude: 0.09,
      rotationDegrees: 0.22,
      speed: 0.16,
    },
  },

  renderer: {
    // DPR is clamped per tier in src/lib/scene/device.ts (`clampedPixelRatio`).
    /** Lifted from the port's 0.58: the reference is a bright, open daylight meadow. */
    toneMappingExposure: 1.35,
    // MSAA samples on the offscreen scene target are per tier: `tiers.msaaSamples`.
  },

  /** Bluish exponential haze so the far grass melts into the sky, not into white. */
  fog: { density: 0.0045 },

  /**
   * Terrain octaves — amplitude and feature size, in world units.
   *
   * Retuned away from the port's single broad swell to the reference's rolling
   * dunes: a dominant mound every ~30 units, a secondary swell breaking it up,
   * and a fine octave so the silhouette is not a clean sine.
   */
  terrain: [
    { amplitude: 5.0, scale: 46 },
    { amplitude: 1.9, scale: 17 },
    { amplitude: 0.35, scale: 5 },
  ],

  /**
   * Depth of field. `focusDistance` is metres from the eye; everything nearer or
   * further ramps to `maxBlur` (in pixels at 1080p) across `focusRange`.
   * The reference's foreground is blurred harder than its background, which is
   * what `nearBlurBoost` buys.
   */
  dof: {
    /** Metres from the eye to the sharp band — the near mound in the reference. */
    focusDistance: 19,
    /** Near and far are ramped separately: the foreground blurs hard and fast, */
    nearRange: 1,
    maxNearBlur: 8.5,
    /** while the hills and sky only ever go soft, never milky. */
    farRange: 200,
    maxFarBlur: 8.5,
  },

  /**
   * Lighting for the whole scene. There are no `THREE.Light`s at all — the
   * blades and the ground are both custom shaders and neither reads one, so a
   * light in the graph would do nothing but cost a program recompile. These
   * constants are the light, and both materials read the same ones so the field
   * and the floor under it always agree.
   */
  grassLight: {
    /**
     * Floor brightness — what the sky dome alone puts on a blade facing away.
     * Deliberately low: a high ambient floor is exactly what makes a field look
     * flat, because it drowns the difference between the lit and unlit side.
     */
    ambient: 0.52,
    /** Green inter-reflection from the surrounding field — keeps shadows alive. */
    bounce: 0.16,
    /** Sun contribution at full facing. High relative to ambient = contrast. */
    diffuse: 0.9,
    /** How much of the sun term comes from the blade's own facing vs the ground's. */
    bladeWeight: 0.5,
    /**
     * Wrapped-diffuse width. Light bleeds this far past the terminator, which is
     * what thin foliage does — it buys contrast without a black shadow side.
     */
    wrap: 0.35,
    /**
     * Darkening at the root, easing to none at the tip. This is the canopy's own
     * occlusion and it is the single strongest source of depth in a lawn — a
     * dense sward is close to black at the soil and bright at the tips.
     */
    rootShade: 0.5,
    /**
     * How dark a blade gets when it is short relative to the patch around it.
     * Blades buried under their neighbours sit in shade; without this every
     * blade is lit as though it stood alone, which is most of the plasticine
     * look — a uniformly lit mass reads as one moulded object, not thousands
     * of separate leaves.
     */
    canopyAo: 0.38,
    /** Per-blade brightness spread, low and high multipliers. */
    tintRange: [0.82, 1.28],
    /** Fraction of blades that carry a flower colour at the tip. */
    flowerFraction: 0.035,
    /**
     * The raw terrain dot product only spans ~0.5..1.0 on dunes this gentle, so
     * a mound's lit and shaded faces come out nearly the same value. These are
     * the low and high ends that band is stretched across.
     */
    terrainContrast: [0.02, 0.62],
    /** Drifting cloud shadow over the field — large-scale light and shade. */
    cloudShadow: { scale: 0.014, speed: 0.35, strength: 0.3 },
    /**
     * Cast shadow from the terrain up-sun, baked on a grid (`sun-shadow.ts`).
     * `strength` 1 means a fully shadowed slope receives no sun at all, leaving
     * it lit by the sky and the television only — which is the brief for the
     * near hill. `reach` is how far up-sun the march looks for a blocker.
     */
    sunShadow: {
      resolution: 320,
      reach: 70,
      steps: 28,
      softness: 1.6,
      strength: 1,
    },
    /** Blinn-Phong highlight — the shine on blades that lean into the light. */
    specular: 1.0,
    shininess: 40,
    /** Glow through a back-lit blade. Grass is thin; this is most of its life. */
    translucency: 1.35,
    translucencyPower: 3.5,
  },

  sky: {
    radius: 1200,
    widthSegments: 64,
    heightSegments: 48,
    /** 0 = clear, 1 = overcast. Raised for the reference's fair-weather cumulus. */
    cloudCover: 0.38,
    /**
     * Where the large clumping noise lets clouds exist at all: the smoothstep
     * range (`cloudGateLow` to `cloudGateHigh`) over that noise. Lower values
     * open more of the dome to cloud; the original 0.28 to 0.62 left mostly
     * clear sky between a few clumps.
     */
    /**
     * Cloud look. Opacity < 1 keeps the sky reading through them. Brightness
     * scales the whole cloud and caps it (a multiple of `colors.cloud`); it has
     * to stay below what the composite grade can take without clipping — at
     * the current `grade` (contrast 1.26 plus an additive highlight tint) that
     * is ~0.6. Raise the grade's contrast or tint and this must come down.
     */
    cloudOpacity: 0.68,
    cloudBrightness: 0.6,
    cloudGateLow: 0.02,
    cloudGateHigh: 0.42,
    cloudSpeed: 1,
    /** How strongly the warm horizon band reads, 0 = none. */
    horizonGlowStrength: 0.62,
    /**
     * Lower than the port's 34 was raised to. A high sun lights everything from
     * straight above and every slope shades alike — the single biggest cause of
     * a flat-looking field. At 36° the dune faces separate, blades rim-light,
     * and the halo brightens the sky on the sun's side.
     *
     * It stays out of frame on elevation alone: the top edge of this camera sits
     * at ~16°, so the disc never enters however the azimuth moves.
     */
    sunElevationDeg: 22,
    /**
     * Side light, ~90° off the view axis. Not a free choice — it is what the two
     * highlight terms need. A sun in *front* of the camera cannot form a
     * Blinn-Phong lobe back toward it (the half-vector degenerates when light and
     * view are opposed), so the blades stay matte however high `specular` goes.
     * Side-on, the dune faces also separate into a lit and a shaded side, which
     * is where the contrast across the field comes from.
     */
    sunAzimuthDeg: 68,
  },

  colors: {
    tip: "#616340",
    bottom: "#433c2b",
    skyTop: "#b88466",
    /** Also the fog colour, and the source of the `--scene-backdrop` CSS token. */
    skyHorizon: "#e7c4a5",
    cloud: "#f5e2cc",
    /** Warm band at the horizon — where the light is coming from. */
    horizonGlow: "#e7ab72",
    /**
     * Aerial haze, and it is no longer the same value as `skyHorizon`. With a
     * low sun the sky at the horizon goes warm while distant hills stay cool and
     * blue — tying the two together would drag the hills warm with the sky.
     */
    haze: "#e9c8ac",
    sun: "#f2b16f",
    /**
     * The ground is the floor of the sward, not soil — see the ground shader.
     * These two are its ramp, deliberately darker than the blade ramp, because
     * what shows through a canopy is grass in shade.
     */
    groundBase: "#000000",
    groundTip: "#635b37",
    /** Straw, mixed into the small fraction of blades that read as dried out. */
    dry: "#ac8b4c",
    /** Flower colour, for the small fraction of blades that carry one. */
    flower: "#e4b390",
    /** Sky/ambient light colour — the cool half of the two-light model. */
    skyLight: "#efcaa1",
  },

  /**
   * Local copies of the pmndrs `grass-shader` blade textures. Served same-origin
   * from `public/assets/grass-hero/`, which is what makes the alpha cutout
   * safe: a tainted or failed alpha map decodes as 0, every fragment hits
   * `discard`, and the field vanishes leaving a bare hill under a perfect sky.
   */
  textures: {
    diffuse: "/assets/grass-hero/blade-diffuse.jpg",
    alpha: "/assets/grass-hero/blade-alpha.jpg",
  },
} as const;

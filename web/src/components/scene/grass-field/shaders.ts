// 📖 Docs: obsidian/frontend/components/scene.md

/**
 * GLSL for the grass field and its sky dome.
 *
 * Tone mapping and colour management stay in-material rather than in a pass:
 *
 * - The grass appends `<tonemapping_fragment>` then `<colorspace_fragment>`, so
 *   it obeys `toneMappingExposure`.
 * - The sky is `toneMapped: false` and appends **only** `<colorspace_fragment>`,
 *   making it exposure-independent — the grass exposure can be pushed around
 *   without washing the horizon band to white.
 *
 * The one real pass is depth of field (`DOF_FRAGMENT_SHADER`), which composites
 * the offscreen colour + depth to screen. It is the last thing that runs, and it
 * therefore reads and writes sRGB-encoded values — it converts to linear itself
 * to average them, because blurring in gamma space eats highlights.
 *
 * Both chunks are resolved by three's `WebGLProgram` for a `ShaderMaterial`, and
 * `<colorspace_fragment>` exists only from r0.152 onward — hence the pinned
 * r0.160 in `package.json`.
 */

/** 2D simplex noise (Ashima / Gustavson, public domain) for the vertex stage. */
export const SIMPLEX_GLSL = /* glsl */ `
vec3 mod289(vec3 x){ return x - floor(x*(1.0/289.0))*289.0; }
vec2 mod289(vec2 x){ return x - floor(x*(1.0/289.0))*289.0; }
vec3 permute(vec3 x){ return mod289(((x*34.0)+1.0)*x); }
float snoise(vec2 v){
  const vec4 C = vec4(0.211324865405187, 0.366025403784439, -0.577350269189626, 0.024390243902439);
  vec2 i  = floor(v + dot(v, C.yy));
  vec2 x0 = v -   i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz; x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute( permute( i.y + vec3(0.0, i1.y, 1.0)) + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0,x0), dot(x12.xy,x12.xy), dot(x12.zw,x12.zw)), 0.0);
  m = m*m; m = m*m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0*a0 + h*h);
  vec3 g;
  g.x  = a0.x  * x0.x  + h.x  * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}
`;

/**
 * Blade vertex stage. The ordering is load-bearing:
 *
 * 1. `frc` is the vertex's fraction up the blade (0 root, 1 tip). It weights the
 *    twist, the colour ramp and the cursor bend — which is why the roots stay
 *    planted while the tips move.
 * 2. The wind noise samples `(time - offset.x/50, time - offset.z/50)`: time is
 *    *added* on both axes while position is subtracted, so the noise field
 *    scrolls diagonally and gusts read as travelling bands, not per-blade jitter.
 * 3. The slerp runs from a pure-yaw quaternion (rebuilt from the half-angle
 *    sin/cos) to the blade's full orientation, weighted by `frc`. Twisting the
 *    quad along its length is what makes a flat plane look like a curved blade.
 * 4. The wind bend is applied after the twist, in blade space, so it compounds
 *    toward the tip.
 * 5. The instance `offset` is added last — the blade is built, twisted and bent
 *    at the origin, then translated onto its spot on the hill.
 */
/** Shared by everything the sun lights. */
export const SUN_SHADOW_GLSL = /* glsl */ `
// Sun visibility, baked on a grid (see sun-shadow.ts). 1 = full sun, 0 = in the
// shadow of terrain up-sun of this point.
float sunVisibility(vec2 worldXZ, sampler2D shadowMap, vec2 origin, float size){
  vec2 uv = (worldXZ - origin) / size;
  // Outside the baked square, assume open sky rather than shadow.
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 1.0;
  return texture2D(shadowMap, uv).r;
}
`;

/** Shared by everything the television lights. */
export const TV_LIGHT_GLSL = /* glsl */ `
// The television's screen as a light. Not a THREE.Light — nothing in this scene
// reads one (ADR-0030) — so every surface that wants it runs this.
//
// Three factors: inverse-square-ish falloff, how squarely the surface faces the
// set, and how squarely the *screen* faces the surface. The third is what keeps
// it reading as a screen rather than a bare bulb: a CRT throws its light forward
// into a cone, so the grass in front of the set lights up and the grass behind
// it stays dark, which is most of what makes the object look like it belongs.
vec3 screenLight(vec3 worldPos, vec3 normal, vec3 tvPos, vec3 tvDir,
                 vec3 tvColor, float intensity, float radius, float focus,
                 float flicker){
  vec3 toTv = tvPos - worldPos;
  float dist = length(toTv);
  vec3 L = toTv / max(dist, 0.0001);
  float falloff = 1.0 / (1.0 + (dist / radius) * (dist / radius) * 4.0);
  // Wrapped, because grass is thin and a hard terminator on a point light
  // looks like a decal rather than illumination.
  float facing = max((dot(normal, L) + 0.45) / 1.45, 0.0);
  float cone = pow(max(dot(-L, tvDir), 0.0), focus);
  return tvColor * intensity * falloff * facing * cone * flicker;
}
`;

export const GRASS_VERTEX_SHADER = /* glsl */ `
attribute vec3 offset;
attribute vec4 orientation;
attribute float halfRootAngleSin;
attribute float halfRootAngleCos;
attribute float stretch;
attribute float groundLight;
attribute vec2 variation;
uniform float time;
// The wind has its own clock and gain, so a gust can race the ripples across
// the field without also speeding up the cloud shadows, which run on the
// time uniform shared with the ground.
uniform float windTime;
uniform float windStrength;
// Gust: a shared lean in the wind direction, modulated by a long wave that
// rolls across the field. Zero when there is no gust.
uniform float windLean;
uniform float windWave;
uniform float bladeHeight;
uniform sampler2D uBendMap;
uniform vec2 uBendOrigin;
uniform float uBendSize;
uniform float uMouseStrength;
uniform float uBendReference;
uniform float uBendFarStrength;
uniform float uRootShade;
uniform float uCloudShadowScale;
uniform float uCloudShadowSpeed;
uniform float uCloudShadowStrength;
varying vec2 vUv;
varying float frc;
varying vec3 vNormal;
varying vec3 vView;
varying float vGroundLight;
varying float vRootShade;
varying vec2 vVariation;
varying float vSunMask;
varying float vDepth;
varying vec3 vWorldPos;
${SIMPLEX_GLSL}
// rotate a vector by a quaternion
vec3 rotateVectorByQuaternion(vec3 v, vec4 q){
  return 2.0 * cross(q.xyz, v * q.w + cross(q.xyz, v)) + v;
}
// spherical linear interpolation between two quaternions
vec4 slerp(vec4 v0, vec4 v1, float t){
  normalize(v0); normalize(v1);
  float d = dot(v0, v1);
  if (d < 0.0) { v1 = -v1; d = -d; }
  const float THRESHOLD = 0.9995;
  if (d > THRESHOLD) return normalize(v0 + t * (v1 - v0));
  float theta_0 = acos(d);
  float theta = theta_0 * t;
  float sin_theta = sin(theta);
  float sin_theta_0 = sin(theta_0);
  float s0 = cos(theta) - d * sin_theta / sin_theta_0;
  float s1 = sin_theta / sin_theta_0;
  return (s0 * v0) + (s1 * v1);
}
void main() {
  // relative position of vertex along the blade (0 root -> 1 tip)
  frc = position.y / float(bladeHeight);
  // scrolling wind noise
  float noise = 1.0 - (snoise(vec2((windTime - offset.x / 50.0), (windTime - offset.z / 50.0))));
  // orientation slerps from the root-yaw quaternion to the blade's own
  vec4 direction = vec4(0.0, halfRootAngleSin, 0.0, halfRootAngleCos);
  direction = slerp(direction, orientation, frc);
  vec3 vPosition = vec3(position.x, position.y + position.y * stretch, position.z);
  vPosition = rotateVectorByQuaternion(vPosition, direction);
  // the quad's own face normal, carried through the same rotations as the vertex
  vec3 bladeNormal = rotateVectorByQuaternion(vec3(0.0, 0.0, 1.0), direction);
  // apply the wind bend (tips bend more)
  // The wind quaternion's axis is (1, 0, -1), which tips blades toward +X +Z,
  // so the wave travels that way too — a gust rolling downwind. Wavelength
  // ~28 units, moving ~7 units per second of wind clock.
  float gustWave = sin(dot(offset.xz, vec2(0.7071)) * 0.22 - windTime * 6.0);
  float lean = windLean * (1.0 - windWave * 0.5 + windWave * 0.5 * gustWave);
  float halfAngle = noise * 0.15 * windStrength + lean;
  vec4 windQuat = normalize(vec4(sin(halfAngle), 0.0, -sin(halfAngle), cos(halfAngle)));
  vPosition = rotateVectorByQuaternion(vPosition, windQuat);
  bladeNormal = rotateVectorByQuaternion(bladeNormal, windQuat);
  // Cursor breeze, read from the bend map rather than from the pointer itself.
  // The map remembers: a blade stays down after the pointer has gone and comes
  // back up as the map decays, which is what makes a sweep leave a wake instead
  // of a line that heals the instant it is drawn.
  vec2 bendUv = (offset.xz - uBendOrigin) / uBendSize;
  // RG is the spring's current displacement (a signed vector, not the trail
  // itself), so the blade lags the dent, overshoots it and settles.
  vec2 bendDisplacement = texture2D(uBendMap, bendUv).rg;
  // Outside the mapped square there is no dent to read; without this the edge
  // texel would smear a permanent bend across the whole far field.
  float inside = step(0.0, bendUv.x) * step(bendUv.x, 1.0)
               * step(0.0, bendUv.y) * step(bendUv.y, 1.0);
  // Deeper with distance, so a dent on the far hills reads like one up close.
  float bendDistanceScale = clamp(
    distance(offset.xz, cameraPosition.xz) / max(uBendReference, 0.001),
    1.0, max(uBendFarStrength, 1.0)
  );
  vec2 push = bendDisplacement * uMouseStrength * bendDistanceScale * inside * frc;
  float bend = length(push);
  vPosition.x += push.x;
  vPosition.z += push.y;
  vPosition.y -= bend * bend * 0.35;
  // There are no lights in the scene graph at all; this shader and the ground
  // shader are the lighting model, and they read the same constants so the
  // canopy and the floor under it always agree. Finished per fragment: shading a
  // blade per-vertex bands badly across six rows, and a specular highlight
  // computed per-vertex is worse than none.
  vec3 worldPosition = offset + vPosition;
  vNormal = bladeNormal;
  vView = cameraPosition - worldPosition;
  vGroundLight = groundLight;
  vVariation = variation;
  // Contact shade, squared. The canopy's occlusion does not fall off linearly
  // with height - light drops away fast near the soil - and the linear ramp is
  // what made the sward read as one smoothly shaded surface.
  float shade = mix(1.0 - uRootShade, 1.0, pow(frc, 1.4));
  // times this blade's own burial under its neighbours
  vRootShade = shade * variation.y;

  // Cloud shadows drifting over the field. Big, soft bands of light and shade
  // are how an open meadow actually looks under fair-weather cumulus, and they
  // give the eye a large-scale contrast that per-blade shading cannot: without
  // them every part of the field is lit identically and the whole thing reads
  // as one evenly lit surface however good the close-up shading is.
  float shadowNoise = snoise(
    offset.xz * uCloudShadowScale + vec2(time * uCloudShadowSpeed)
  );
  vSunMask = mix(
    1.0 - uCloudShadowStrength, 1.0, smoothstep(-0.30, 0.45, shadowNoise)
  );

  vUv = uv;
  vWorldPos = worldPosition;
  vec4 mvPosition = modelViewMatrix * vec4(worldPosition, 1.0);
  // Distance from the eye, for fog. The grass had none: scene.fog only reaches
  // materials that implement it, and this shader never did — so the ground
  // hazed into the sky with distance while the blades in front of it stayed
  // fully saturated, and the two came apart at the horizon.
  vDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
}
`;

/**
 * Blade fragment stage.
 *
 * The double `mix` is not a typo: both interpolate *toward the texture* by
 * `frc`, so the first pushes `tipColor` into the low end and the second pushes
 * `bottomColor` in on top of that — the compound is a dark base rising into
 * saturated green, with the diffuse only fully visible near the tip.
 *
 * The `discard` is this scene's single point of failure: if the alpha map fails
 * to decode it samples as 0, every blade is thrown away, and the field renders
 * as a bare hill under a perfect sky — geometry intact, grass apparently gone.
 * The textures are therefore served same-origin from `public/`.
 */
export const GRASS_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D map;
uniform sampler2D alphaMap;
uniform vec3 tipColor;
uniform vec3 bottomColor;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uDryColor;
uniform vec2 uTintRange;
uniform vec2 uTerrainContrast;
uniform vec3 uSunDir;
uniform float uAmbient;
uniform float uBounce;
uniform float uDiffuse;
uniform float uBladeWeight;
uniform float uWrap;
uniform float uSpecular;
uniform float uShininess;
uniform float uTranslucency;
uniform float uTranslucencyPower;
varying vec2 vUv;
varying float frc;
varying vec3 vNormal;
varying vec3 vView;
varying float vGroundLight;
varying float vRootShade;
varying vec2 vVariation;
varying float vSunMask;
varying float vDepth;
varying vec3 vWorldPos;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uFlowerColor;
uniform float uFlowerFraction;
uniform vec3 uTvPosition;
uniform vec3 uTvDirection;
uniform vec3 uTvColor;
uniform float uTvIntensity;
uniform float uTvRadius;
uniform float uTvFocus;
uniform float uTvFlicker;
uniform sampler2D uShadowMap;
uniform vec2 uShadowOrigin;
uniform float uShadowSize;
uniform float uShadowStrength;
${TV_LIGHT_GLSL}
${SUN_SHADOW_GLSL}
void main() {
  float alpha = texture2D(alphaMap, vUv).r;
  if (alpha < 0.15) discard;
  vec4 col = vec4(texture2D(map, vUv));
  col = mix(vec4(tipColor, 1.0), col, frc);
  col = mix(vec4(bottomColor, 1.0), col, frc);

  // Per-blade variation. Every blade sharing one ramp is the other half of the
  // plasticine look: a real sward is thousands of slightly different greens, and
  // a fraction of it is always dying back to straw. Without this the field is
  // one material with a shadow on it.
  float tint = vVariation.x;
  col.rgb *= mix(uTintRange.x, uTintRange.y, tint);
  col.rgb = mix(col.rgb, uDryColor, smoothstep(0.86, 1.0, tint) * 0.5);
  // A small fraction of blades carry a flower at the tip. Cheapest possible
  // flowers — no extra geometry, just the top of an existing blade repainted.
  float flower = step(1.0 - uFlowerFraction, tint) * smoothstep(0.55, 0.95, frc);
  col.rgb = mix(col.rgb, uFlowerColor, flower);

  vec3 N = normalize(vNormal);
  vec3 V = normalize(vView);
  vec3 L = normalize(uSunDir);
  // A blade is a double-sided quad with no back, so the normal is flipped to
  // face the camera rather than abs()-ed. abs() throws away which way the blade
  // leans, and with it every highlight that depends on the lean.
  if (dot(N, V) < 0.0) N = -N;

  // Wrapped diffuse: light bleeds a little past the terminator, which is what
  // thin foliage does and what keeps the shadow side from going black.
  float ndl = dot(N, L);
  float wrapped = max((ndl + uWrap) / (1.0 + uWrap), 0.0);
  // Terrain-scale shading and blade-scale shading, mixed. The first makes a
  // mound read as a mound; the second is the per-blade break-up.
  //
  // The terrain term is remapped before use: these are gentle dunes, so the raw
  // dot product only ever spans roughly 0.5..1.0 and the lit and shaded faces of
  // a mound come out nearly the same value. Stretching that narrow band across
  // the full range is what makes the relief read as lit from one side.
  float terrain = smoothstep(uTerrainContrast.x, uTerrainContrast.y, vGroundLight);
  float sunTerm = mix(terrain, wrapped, uBladeWeight);

  // Two coloured lights, not one scalar. The shadow side is lit by the sky and
  // goes cool; the lit side is lit by the sun and goes warm. That split is what
  // a photograph has and a single grey multiplier never can — it is most of the
  // difference between "shaded" and "flat".
  // Plus a bounce term in the blade's own colour. A grass field inter-reflects
  // heavily — the light in a hollow has been green twice over — and without it
  // a blue-tinted ambient desaturates every shadow to grey.
  vec3 ambientLight = uSkyColor * uAmbient + col.rgb * uBounce;
  // Cast shadow from the terrain up-sun. With the sun low this is what puts the
  // near slope in shade while the crest stays lit — and it is not something the
  // shading term can express, since a shadowed slope points the same way as a
  // sunlit one.
  float sunVis = sunVisibility(vWorldPos.xz, uShadowMap, uShadowOrigin, uShadowSize);
  sunVis = mix(1.0, sunVis, uShadowStrength);
  vec3 sunLight = uSunColor * uDiffuse * sunTerm * vSunMask * sunVis;
  vec3 lit = col.rgb * (ambientLight + sunLight) * vRootShade;

  // Specular. This is the "shine": a tight Blinn-Phong lobe weighted toward the
  // tip, so the blades that happen to lean into the light flare and the rest
  // stay matte. It is what separates grass from felt.
  vec3 H = normalize(L + V);
  // Gloss varies per blade too — an even sheen across the whole field reads as
  // a wet plastic surface rather than as leaves.
  float spec = pow(max(dot(N, H), 0.0), uShininess) * uSpecular * frc
             * mix(0.35, 1.7, tint) * vSunMask * sunVis;
  lit += uSunColor * spec;

  // Translucency: a blade lit from behind glows, because it is thin. Strongest
  // when looking toward the sun through a blade that faces away from it.
  float through = pow(max(dot(V, -L), 0.0), uTranslucencyPower);
  lit += col.rgb * uSunColor * through * uTranslucency * max(-ndl, 0.0) * frc * sunVis;

  // The television.
  lit += col.rgb * screenLight(vWorldPos, N, uTvPosition, uTvDirection, uTvColor,
                               uTvIntensity, uTvRadius, uTvFocus, uTvFlicker);

  gl_FragColor = vec4(lit, col.a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  // Fog last, matching three's own ordering (it applies fog after tone mapping
  // and encoding, not before).
  float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, clamp(fogFactor, 0.0, 1.0));
}
`;

/** Forwards the un-normalised local position as a view direction. */
export const SKY_VERTEX_SHADER = /* glsl */ `
varying vec3 vDir;
void main(){ vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`;

/** Gradient + sun disc + halo + drifting FBM clouds. Writes linear; the chunk encodes. */
export const SKY_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uTop; uniform vec3 uHorizon; uniform vec3 uSunColor; uniform vec3 uSunDir;
uniform float uTime; uniform vec3 uCloudColor; uniform float uCloudCover; uniform float uCloudSpeed;
uniform vec2 uCloudGate;
uniform float uCloudOpacity; uniform float uCloudBrightness;
uniform vec3 uHorizonGlow; uniform float uHorizonGlowStrength;
varying vec3 vDir;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = hash(i), b = hash(i + vec2(1.0, 0.0)), c = hash(i + vec2(0.0, 1.0)), d = hash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
float fbm(vec2 p){
  float v = 0.0, a = 0.5;
  for(int i = 0; i < 4; i++){ v += a * vnoise(p); p = p * 2.02 + 7.3; a *= 0.5; }
  return v;
}
// Billow noise: fbm over the ABSOLUTE value of signed noise. Folding the noise
// at zero turns every smooth zero-crossing into a crease, which is what gives
// cumulus their lumpy, cauliflower structure. Plain fbm, thresholded at any
// level, is a blurry stain - it has no such feature to find.
float billow(vec2 p){
  float v = 0.0, a = 0.5;
  for(int i = 0; i < 4; i++){
    v += a * abs(vnoise(p) * 2.0 - 1.0);
    p = p * 2.05 + 4.1;
    a *= 0.5;
  }
  return v;
}
// Domain warp on top: feeding the noise a noise-displaced coordinate breaks the
// remaining regularity out of the lobes.
float clouds(vec2 p){
  vec2 warp = vec2(fbm(p + 3.1), fbm(p + 7.7));
  return billow(p + warp * 0.6);
}
void main(){
  vec3 d = normalize(vDir);
  float h = clamp(d.y, 0.0, 1.0);
  vec3 col = mix(uHorizon, uTop, pow(h, 0.5));

  // Warm band hugging the horizon, biased to the sun's side of the dome.
  // A sky that is only a vertical ramp has no direction in it — this is what
  // tells the eye where the light is coming from when the sun itself is out of
  // frame, and it is most of the difference between "a blue gradient" and
  // "late afternoon".
  float horizonBand = pow(1.0 - h, 7.0);
  // not named flat: that is a reserved interpolation qualifier in GLSL ES 3.0
  vec2 viewFlat = normalize(d.xz + vec2(1e-5));
  vec2 sunFlat = normalize(uSunDir.xz + vec2(1e-5));
  float sunSide = dot(viewFlat, sunFlat) * 0.5 + 0.5;
  col = mix(col, uHorizonGlow, horizonBand * mix(0.25, 1.0, sunSide) * uHorizonGlowStrength);

  float sd = max(dot(d, normalize(uSunDir)), 0.0);
  col += uSunColor * pow(sd, 400.0) * 3.0;    // sun disc
  col += uSunColor * 0.20 * pow(sd, 6.0);     // soft halo

  // --- drifting cumulus on the dome ---
  // divide by (d.y + const), NOT max(d.y, const): the additive term keeps the
  // projection finite and smooth right down to the horizon, so there is no frozen
  // band and no vertical "drip" streaks.
  // horizonFade still ramps rather than snaps - a narrow band puts a hard lower
  // edge on the cloud haze that reads as a horizontal seam splitting the sky.
  // But the original ramp ran to 0.75, and this camera looks near-horizontal:
  // the whole visible sky sits below d.y ~ 0.4, so every cloud in frame was
  // being multiplied down to a pale wash. It now reaches full by 0.3.
  float horizonFade = smoothstep(-0.03, 0.18, d.y);
  vec2 cp = (d.xz / (d.y + 0.35)) * 0.88;
  cp += vec2(uTime * 0.02 * uCloudSpeed, uTime * 0.006 * uCloudSpeed);

  // Billow sits lower than fbm (it is a sum of folded magnitudes, not of
  // signed lobes), so the threshold range is its own, not the fbm one.
  float cover = mix(0.60, 0.16, clamp(uCloudCover, 0.0, 1.0));
  float n = clouds(cp);
  float density = smoothstep(cover, cover + 0.13, n);

  // A second, much larger noise gates where clouds are allowed at all. Without
  // it the field is an even speckle across the whole dome; cumulus come in
  // clumps with clear blue between them, and that separation is most of what
  // reads as "fair weather" rather than "haze".
  float clump = smoothstep(uCloudGate.x, uCloudGate.y, fbm(cp * 0.34 + 19.7));

  // Fake the third dimension: sample the same cloud field again, shifted toward
  // the sun. Where the shifted sample is thinner, this part of the cloud faces
  // the light and is a lit top; where it is thicker, the cloud is shadowing
  // itself and this is an underside. That difference is the whole illusion of
  // volume, and it costs one extra noise fetch.
  vec2 sunFlow = normalize(uSunDir.xz + vec2(0.001)) * 0.22;
  float towardSun = clouds(cp + sunFlow);
  float selfShadow = clamp((n - towardSun) * 2.6 + 0.5, 0.0, 1.0);

  // A thinner, faster high layer for depth - real skies are never one plane.
  vec2 hp = cp * 2.3 + vec2(uTime * 0.012 * uCloudSpeed, 0.0);
  float high = smoothstep(cover + 0.20, cover + 0.42, fbm(hp)) * 0.4;

  float ca = clamp(density * clump + high * clump * horizonFade, 0.0, 1.0) * horizonFade;

  vec3 cloudShadow = uCloudColor * 0.52;
  vec3 cloudLit = uCloudColor;
  vec3 cloudCol = mix(cloudShadow, cloudLit, selfShadow);
  // Sun warmth as a *tint*, not added light. Adding the rim (+0.45) and the
  // warm tops (+0.28) on top of a white cloud pushed clouds near the sun to
  // ~1.7 in linear light — past the bloom threshold, so a cloud drifting
  // toward the sun blew out into a glowing blob with pink fringes.
  float sunTint = smoothstep(0.3, 0.9, sd);
  cloudCol = mix(cloudCol, cloudCol * mix(vec3(1.0), uSunColor * 1.6, 0.35), sunTint);
  cloudCol = mix(cloudCol, uSunColor, 0.18 * smoothstep(0.55, 1.0, sd) * (1.0 - density));
  // Brightness is scaled as a whole (keeping lit-vs-shadow contrast) and then
  // capped. The ceiling is set by the *grade*, not by bloom: the composite
  // raises contrast (×1.26) and then ADDS a warm highlight tint (up to +0.6), so
  // anything above ~0.58 linear lands on pure white on screen. A cap of 0.86
  // stopped the bloom blow-out but still clipped a large cloud mass to a flat
  // white patch.
  cloudCol = min(cloudCol * uCloudBrightness, uCloudColor * uCloudBrightness);
  // Soft, never opaque, and thinner still right against the sun's glare.
  float nearSun = smoothstep(0.82, 1.0, sd);
  col = mix(col, cloudCol, ca * uCloudOpacity * (1.0 - 0.55 * nearSun));

  // dither: break up 8-bit banding on the smooth blue ramp so the gradient
  // reads as one continuous sky instead of splitting into flat stepped bands
  float dither = (hash(gl_FragCoord.xy) - 0.5) / 255.0;
  col += dither;

  gl_FragColor = vec4(col, 1.0);
  #include <colorspace_fragment>
}
`;

/** Fullscreen triangle-quad: `position` is already in clip space, so no camera is read. */
export const DOF_VERTEX_SHADER = /* glsl */ `
varying vec2 vUv;
void main(){ vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

/**
 * Depth-of-field composite.
 *
 * Scatter-as-gather: each pixel reads its own depth, works out a circle of
 * confusion, and averages a golden-angle spiral of taps across that radius.
 * Near and far are ramped independently — a foreground that dissolves and a
 * background that only softens is what the reference frame does, and a single
 * symmetric ramp cannot express it.
 *
 * Why this is hand-rolled rather than three's `BokehPass`: that pass re-renders
 * the scene with an override depth material, which would drop the instanced
 * attributes and stack all 190k blades at the origin. Reading the depth texture
 * the normal pass already wrote sidesteps the problem entirely.
 */
export const DOF_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uScene;
uniform sampler2D uDepth;
uniform sampler2D uBloom;
uniform float uBloomIntensity;
uniform vec2 uTexel;
uniform float uNear;
uniform float uFar;
uniform float uFocusDistance;
uniform float uNearRange;
uniform float uFarRange;
uniform float uMaxNearBlur;
uniform float uMaxFarBlur;
uniform float uContrast;
uniform float uSaturation;
uniform float uLift;
uniform vec3 uShadowTint;
uniform vec3 uHighlightTint;
uniform float uTintStrength;
uniform float uVignette;
uniform float uVignetteRadius;
uniform float uVignetteRoundness;
uniform float uVignetteSoftness;
uniform vec3 uVignetteColor;
uniform float uAspect;
varying vec2 vUv;

const int TAPS = 28;
const float GOLDEN_ANGLE = 2.39996323;

/** Window-space depth -> positive distance from the eye, in world units. */
float viewDistance(float depth){
  float ndc = depth * 2.0 - 1.0;
  return (2.0 * uNear * uFar) / (uFar + uNear - ndc * (uFar - uNear));
}

/** Linear -> sRGB, the real piecewise transfer rather than a 1/2.2 approximation. */
vec3 linearToSRGB(vec3 c){
  c = max(c, 0.0);
  return mix(c * 12.92, 1.055 * pow(c, vec3(0.41666667)) - 0.055, step(vec3(0.0031308), c));
}

/** Blur radius in pixels for a given distance from the eye. */
float blurRadius(float dist){
  float near = clamp((uFocusDistance - dist) / uNearRange, 0.0, 1.0) * uMaxNearBlur;
  float far  = clamp((dist - uFocusDistance) / uFarRange, 0.0, 1.0) * uMaxFarBlur;
  return max(near, far);
}

void main(){
  float centreDist = viewDistance(texture2D(uDepth, vUv).x);
  float radius = blurRadius(centreDist);

  // The offscreen buffer is linear, so these average correctly as they are.
  vec3 sum = texture2D(uScene, vUv).rgb;
  float weight = 1.0;

  for (int i = 0; i < TAPS; i++){
    float t = (float(i) + 0.5) / float(TAPS);
    float angle = float(i) * GOLDEN_ANGLE;
    // sqrt spreads the taps evenly over the disc's AREA, not its radius —
    // without it the samples bunch at the centre and the bokeh looks ringed
    vec2 offset = vec2(cos(angle), sin(angle)) * sqrt(t) * radius * uTexel;
    vec2 uv = vUv + offset;

    // A tap is only allowed to bleed in if it is itself at least as blurred as
    // the pixel it lands on. That is what keeps a sharp mound from smearing
    // into the soft grass in front of it.
    float tapRadius = blurRadius(viewDistance(texture2D(uDepth, uv).x));
    float w = clamp(tapRadius / max(radius, 0.0001), 0.0, 1.0);

    sum += texture2D(uScene, uv).rgb * w;
    weight += w;
  }

  // Bloom added in linear light, before the encode — which is the whole point.
  // An additive quad in front of the set can only ever sit *around* the screen;
  // light that has been blurred across the frame buffer washes over the bezel,
  // so the screen's own edge dissolves the way a real over-exposed highlight
  // does.
  vec3 blurred = sum / weight + texture2D(uBloom, vUv).rgb * uBloomIntensity;

  // Grade in display space, after the encode. Contrast and saturation applied
  // to linear light behave nothing like the numbers suggest — a contrast of 1.3
  // on linear values crushes the shadows to black and blows the sky out — and
  // every grading intuition is a display-space intuition anyway.
  vec3 c = linearToSRGB(blurred);

  c = (c - 0.5) * uContrast + 0.5 + uLift;

  float luma = dot(c, vec3(0.2126, 0.7152, 0.0722));
  c = mix(vec3(luma), c, uSaturation);

  // Split tone: shadows toward the sky, highlights toward the screen, so the
  // two light sources read as two colours of light rather than one with a cast.
  c += uShadowTint * (1.0 - smoothstep(0.0, 0.55, luma)) * uTintStrength;
  c += uHighlightTint * smoothstep(0.45, 1.0, luma) * uTintStrength;

  // Vignette: a rounded-rectangle plateau across the middle, then a soft ramp
  // out to the edges.
  //
  // The plateau is the whole point — an earlier version ramped from the very
  // first pixel off centre, leaving no untouched region, which is why raising it
  // dimmed the whole frame like an exposure control.
  //
  // The *shape* matters too. A radial falloff gives an ellipse inscribed in the
  // frame, so it bites deepest exactly at the middle of each edge and leaves the
  // corners comparatively bright — the opposite of what a lens does. A rounded
  // box hugs the frame, so the darkening sits in a band of even width with the
  // corners deepest.
  //
  // Worked in height-relative units (x scaled by aspect) so the corner radius is
  // circular on screen rather than stretched with the frame.
  vec2 vignettePoint = vUv - 0.5;
  vignettePoint.x *= uAspect;
  vec2 vignetteHalf = vec2(0.5 * uAspect, 0.5) * uVignetteRadius;
  float vignetteCorner =
    min(vignetteHalf.x, vignetteHalf.y) * clamp(uVignetteRoundness, 0.0, 1.0);
  // Signed distance to a rounded box: negative inside the plateau, positive out.
  vec2 vignetteQ = abs(vignettePoint) - vignetteHalf + vignetteCorner;
  float vignetteSdf =
    min(max(vignetteQ.x, vignetteQ.y), 0.0) +
    length(max(vignetteQ, 0.0)) -
    vignetteCorner;
  float vignetteFalloff =
    smoothstep(0.0, max(uVignetteSoftness, 0.001), vignetteSdf);
  // mix toward a colour rather than multiplying down, so the vignette can be
  // tinted; with black it is exactly the old multiply.
  c = mix(c, uVignetteColor, clamp(uVignette * vignetteFalloff, 0.0, 1.0));

  gl_FragColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}
`;

/** Ground vertex stage. The mesh has an identity transform, so position is world. */
export const GROUND_VERTEX_SHADER = /* glsl */ `
varying vec3 vWorld;
varying vec3 vGroundNormal;
varying float vDepth;
void main(){
  vWorld = position;
  vGroundNormal = normal;
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mvPosition.z;
  gl_Position = projectionMatrix * mvPosition;
}
`;

/**
 * Ground fragment stage — the floor of the sward, not soil.
 *
 * Nothing here is meant to be looked at directly. Its whole job is that wherever
 * the eye finds a gap between blades, or looks past the far edge of the blade
 * disc, what it finds is the dark base of grass rather than bare earth. So it
 * runs the *same* lighting as the blades — terrain term with the same remap, the
 * same drifting cloud shadow, the same sun and sky colours — and is tinted from
 * the same two-colour ramp. Give the ground its own look and every gap in the
 * canopy turns into a visible patch of dirt.
 */
export const GROUND_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uBaseColor;
uniform vec3 uTipColor;
uniform vec3 uSunColor;
uniform vec3 uSkyColor;
uniform vec3 uSunDir;
uniform float uAmbient;
uniform float uDiffuse;
uniform vec2 uTerrainContrast;
uniform float uTime;
uniform float uCloudShadowScale;
uniform float uCloudShadowSpeed;
uniform float uCloudShadowStrength;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform vec3 uTvPosition;
uniform vec3 uTvDirection;
uniform vec3 uTvColor;
uniform float uTvIntensity;
uniform float uTvRadius;
uniform float uTvFocus;
uniform float uTvFlicker;
uniform sampler2D uShadowMap;
uniform vec2 uShadowOrigin;
uniform float uShadowSize;
uniform float uShadowStrength;
varying vec3 vWorld;
varying vec3 vGroundNormal;
varying float vDepth;
${SIMPLEX_GLSL}
${TV_LIGHT_GLSL}
${SUN_SHADOW_GLSL}
float gHash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123); }
float gNoise(vec2 p){
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  float a = gHash(i), b = gHash(i + vec2(1.0, 0.0));
  float c = gHash(i + vec2(0.0, 1.0)), d = gHash(i + vec2(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
void main(){
  vec3 N = normalize(vGroundNormal);
  vec3 L = normalize(uSunDir);

  // Mottling at two scales. A flat colour under the blades reads as a moulded
  // plane the moment any of it is visible; broken up, it reads as more grass.
  float mottle = gNoise(vWorld.xz * 1.7) * 0.6 + gNoise(vWorld.xz * 7.0) * 0.4;
  vec3 albedo = mix(uBaseColor, uTipColor, mottle * 0.5);

  float terrain = smoothstep(uTerrainContrast.x, uTerrainContrast.y, max(dot(N, L), 0.0));

  float shadowNoise = snoise(
    vWorld.xz * uCloudShadowScale + vec2(uTime * uCloudShadowSpeed)
  );
  float sunMask = mix(
    1.0 - uCloudShadowStrength, 1.0, smoothstep(-0.30, 0.45, shadowNoise)
  );

  float sunVis = mix(
    1.0,
    sunVisibility(vWorld.xz, uShadowMap, uShadowOrigin, uShadowSize),
    uShadowStrength
  );
  vec3 lit = albedo * (uSkyColor * uAmbient + uSunColor * uDiffuse * terrain * sunMask * sunVis);
  lit += albedo * screenLight(vWorld, N, uTvPosition, uTvDirection, uTvColor,
                              uTvIntensity, uTvRadius, uTvFocus, uTvFlicker);

  gl_FragColor = vec4(lit, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  float fogFactor = 1.0 - exp(-uFogDensity * uFogDensity * vDepth * vDepth);
  gl_FragColor.rgb = mix(gl_FragColor.rgb, uFogColor, clamp(fogFactor, 0.0, 1.0));
}
`;

/** Screen vertex stage — geometry position is forwarded, not UVs. */
export const TV_SCREEN_VERTEX_SHADER = /* glsl */ `
varying vec3 vLocal;
void main(){
  vLocal = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * Screen fragment stage: a hot core falling to the edge colour.
 *
 * The falloff is computed from the glass's own bounding box rather than from
 * UVs — the model's UV layout is its own business, and a picture that does not
 * land exactly on the glass is worse than no picture. The thin axis of the box
 * is ignored, so this works whichever way the panel faces.
 */
export const TV_SCREEN_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uCore;
uniform vec3 uEdge;
uniform float uIntensity;
uniform float uGlow;
uniform vec3 uCenter;
uniform vec3 uExtent;
uniform float uEdgeStart;
uniform float uCentreLift;
varying vec3 vLocal;
void main(){
  vec3 offset = (vLocal - uCenter) / max(uExtent, vec3(1e-4));
  // Drop the shallowest axis: that is the glass's thickness, not its face.
  vec2 face = uExtent.x < uExtent.y && uExtent.x < uExtent.z
    ? offset.yz
    : (uExtent.y < uExtent.z ? offset.xz : offset.xy);

  // Box falloff, not radial. A radial one lights an oval in the middle of the
  // glass and leaves the corners dark, which reads as a blob sitting inside the
  // cabinet rather than as a screen that is on. This holds full brightness
  // across the picture area and only softens at the rim, so the whole screen
  // is bright, blooms, and dissolves its own edge.
  float edge = max(abs(face.x), abs(face.y));
  float lit = 1.0 - smoothstep(uEdgeStart, 1.0, edge);
  // A gentle centre lift, because a CRT is brighter in the middle — but it
  // rides on top of a fully lit panel instead of being the whole picture.
  float centre = 1.0 - smoothstep(0.0, 1.4, length(face));
  vec3 col = mix(uEdge, uCore, centre * uCentreLift);
  gl_FragColor = vec4(col * uIntensity * uGlow * lit, 1.0);
  #include <colorspace_fragment>
}
`;

/**
 * Bloom, pass 1 of 3: bright extraction with a soft knee.
 *
 * Reads the linear scene buffer, so the threshold is in linear light and the
 * screen — which is `toneMapped: false` and deliberately over 1 — is the only
 * thing far enough above it to bloom hard.
 */
export const BLOOM_BRIGHT_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uScene;
uniform float uThreshold;
uniform float uKnee;
varying vec2 vUv;
void main(){
  vec3 c = texture2D(uScene, vUv).rgb;
  float brightness = max(c.r, max(c.g, c.b));
  // Soft knee, so a surface hovering at the threshold fades in instead of
  // popping as the frame moves.
  float contribution = smoothstep(uThreshold, uThreshold + max(uKnee, 1e-4), brightness);
  gl_FragColor = vec4(c * contribution, 1.0);
}
`;

/**
 * Bloom, passes 2 and 3: separable Gaussian.
 *
 * Run horizontally then vertically, at reduced resolution, repeatedly with a
 * widening step. Separable because a 2D kernel wide enough to dissolve the
 * screen's edge would cost hundreds of taps per pixel; two 9-tap passes give the
 * same result for eighteen.
 */
export const BLOOM_BLUR_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uSource;
uniform vec2 uDirection;
varying vec2 vUv;
void main(){
  // Gaussian, sigma ~2 texels, normalised.
  float w0 = 0.227027;
  float w1 = 0.194594;
  float w2 = 0.121621;
  float w3 = 0.054054;
  float w4 = 0.016216;
  vec3 sum = texture2D(uSource, vUv).rgb * w0;
  sum += texture2D(uSource, vUv + uDirection * 1.0).rgb * w1;
  sum += texture2D(uSource, vUv - uDirection * 1.0).rgb * w1;
  sum += texture2D(uSource, vUv + uDirection * 2.0).rgb * w2;
  sum += texture2D(uSource, vUv - uDirection * 2.0).rgb * w2;
  sum += texture2D(uSource, vUv + uDirection * 3.0).rgb * w3;
  sum += texture2D(uSource, vUv - uDirection * 3.0).rgb * w3;
  sum += texture2D(uSource, vUv + uDirection * 4.0).rgb * w4;
  sum += texture2D(uSource, vUv - uDirection * 4.0).rgb * w4;
  gl_FragColor = vec4(sum, 1.0);
}
`;

/**
 * Drifting motes.
 *
 * Animated entirely in the vertex stage from a per-particle seed: position,
 * wander and twinkle are all functions of time and that seed, so nothing is
 * written per frame from the CPU and the whole field is one draw call.
 */
export const PARTICLE_VERTEX_SHADER = /* glsl */ `
attribute vec3 seed;
uniform float uTime;
uniform float uSpeed;
uniform float uRise;
uniform float uDrift;
uniform float uSize;
uniform float uPixelRatio;
uniform float uViewportScale;
uniform float uBaseY;
uniform float uHeight;
varying float vPhase;
varying float vFade;
void main(){
  vPhase = seed.x * 6.2831853;

  vec3 p = position;
  // Lateral wander, each mote on its own period so the field never pulses.
  p.x += sin(uTime * uSpeed * (0.6 + seed.y) + vPhase) * uDrift;
  p.z += cos(uTime * uSpeed * (0.5 + seed.z) + vPhase * 1.7) * uDrift;
  // Rise, wrapped: a mote that reaches the top of the band reappears at the
  // bottom, so the swarm never thins out and nothing has to be respawned.
  float travel = uTime * uRise * (0.4 + seed.y);
  p.y = uBaseY + mod(p.y - uBaseY + travel, uHeight);

  vec4 mvPosition = modelViewMatrix * vec4(p, 1.0);
  // Fade the two ends of the band so motes do not pop in and out at the seams.
  float bandPosition = (p.y - uBaseY) / uHeight;
  vFade = smoothstep(0.0, 0.12, bandPosition) * (1.0 - smoothstep(0.82, 1.0, bandPosition));

  // Capped: a mote drifting right past the lens would otherwise become a
  // screen-sized additive sprite — pure fill for a soft blur nobody can read.
  gl_PointSize = min(
    uSize * uPixelRatio * uViewportScale * (60.0 / max(-mvPosition.z, 0.1)),
    48.0 * uPixelRatio
  );
  gl_Position = projectionMatrix * mvPosition;
}
`;

/** Round, soft-edged, additive — and bright enough to reach the bloom threshold. */
export const PARTICLE_FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uColor;
uniform float uBrightness;
uniform float uTwinkle;
uniform float uTwinkleSpeed;
uniform float uTime;
varying float vPhase;
varying float vFade;
void main(){
  float d = length(gl_PointCoord - 0.5) * 2.0;
  float core = pow(max(1.0 - d, 0.0), 2.2);
  if (core <= 0.001) discard;
  float twinkle = mix(1.0, 0.45 + 0.55 * sin(uTime * uTwinkleSpeed + vPhase), uTwinkle);
  gl_FragColor = vec4(uColor * uBrightness * twinkle * core * vFade, core * vFade);
  #include <colorspace_fragment>
}
`;

/**
 * Bend map, stamped and decayed once per frame.
 *
 * This is the field's memory. The previous version bent blades as a pure
 * function of where the cursor *is*, so the moment it moved on, every blade was
 * upright again in the same frame — sweeping quickly left a field that snapped
 * back behind the pointer instead of a wake that settles.
 *
 * RG holds the direction to push, encoded; B holds how hard. Each frame the
 * whole map fades toward zero — that fade *is* the recovery — and a fresh stamp
 * is written where the pointer went, taking the stronger of the two so an old
 * dent is not erased by a glancing pass.
 *
 * The stamp is a capsule along the segment from the previous pointer position to
 * the current one, not a disc at the current one: at speed the pointer can cross
 * many metres between frames, and discs leave a dotted line of separate dents.
 */
export const BEND_STAMP_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uPrevious;
uniform vec2 uOrigin;
uniform float uSize;
uniform vec2 uFrom;
uniform vec2 uTo;
uniform float uRadius;
uniform float uDecay;
uniform float uActive;
uniform vec2 uCamera;
uniform float uReference;
uniform float uFarRadius;
varying vec2 vUv;

/** Distance from p to the segment ab, and the position along it. */
float segmentDistance(vec2 p, vec2 a, vec2 b){
  vec2 ab = b - a;
  float lengthSquared = max(dot(ab, ab), 1e-6);
  float t = clamp(dot(p - a, ab) / lengthSquared, 0.0, 1.0);
  return distance(p, a + ab * t);
}

vec2 segmentClosest(vec2 p, vec2 a, vec2 b){
  vec2 ab = b - a;
  float lengthSquared = max(dot(ab, ab), 1e-6);
  float t = clamp(dot(p - a, ab) / lengthSquared, 0.0, 1.0);
  return a + ab * t;
}

void main(){
  vec3 previous = texture2D(uPrevious, vUv).rgb;
  // Recovery: the dent fades rather than being released. Applied per frame with
  // a factor the CPU derives from real elapsed time, so the rate does not change
  // with frame rate.
  previous.b *= uDecay;

  vec2 world = uOrigin + vUv * uSize;
  vec2 closest = segmentClosest(world, uFrom, uTo);
  float d = distance(world, closest);
  // Wider with distance from the camera, measured at the pointer's path rather
  // than at this texel, so the dent stays round instead of stretching away.
  float radiusScale = clamp(
    distance(closest, uCamera) / max(uReference, 0.001), 1.0, max(uFarRadius, 1.0)
  );
  float stamp = smoothstep(uRadius * radiusScale, 0.0, d) * uActive;

  vec2 away = world - closest;
  vec2 direction = length(away) > 1e-4 ? normalize(away) : vec2(1.0, 0.0);

  // Take the stronger of old and new, so a light pass does not wipe a deep dent.
  float take = step(previous.b, stamp);
  vec2 encoded = mix(previous.rg, direction * 0.5 + 0.5, take);
  gl_FragColor = vec4(encoded, max(previous.b, stamp), 1.0);
}
`;

/**
 * Blade inertia, integrated once per frame over the whole bend map.
 *
 * The trail map says where the field *should* be pressed. Reading it directly
 * made the blades jump into the pose the frame the cursor arrived. Here each
 * texel is a damped spring instead: RG is its displacement, BA its velocity, and
 * the target is the trail's direction scaled by its depth. Semi-implicit Euler,
 * stable while 2 pi frequency delta < 2; the CPU substeps to hold that at low
 * frame rates.
 */
export const BEND_SPRING_FRAGMENT_SHADER = /* glsl */ `
uniform sampler2D uState;
uniform sampler2D uTrail;
uniform float uDelta;
uniform float uStiffness;
uniform float uDamping;
varying vec2 vUv;

void main(){
  vec4 state = texture2D(uState, vUv);
  vec3 trail = texture2D(uTrail, vUv).rgb;
  vec2 target = (trail.rg * 2.0 - 1.0) * trail.b;
  vec2 velocity = state.ba;
  vec2 acceleration = (target - state.rg) * uStiffness - velocity * uDamping;
  velocity += acceleration * uDelta;
  vec2 displacement = state.rg + velocity * uDelta;
  gl_FragColor = vec4(displacement, velocity);
}
`;

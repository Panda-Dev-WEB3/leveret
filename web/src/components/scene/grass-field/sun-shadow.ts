// 📖 Docs: obsidian/frontend/components/scene.md

/**
 * Baked sun-visibility map for the terrain.
 *
 * With the sun low, the crest the television stands on throws a long shadow
 * back over everything in front of it — which is exactly the look the brief
 * asks for, and which no amount of per-blade shading can fake: shading depends
 * only on which way a surface points, and a slope in shadow points the same way
 * as a slope in sunlight.
 *
 * Marched on a grid rather than per blade. Per-blade would be ~420,000 marches
 * against a three-octave height field, several seconds of it; the terrain is
 * smooth at this scale, so a grid the shaders sample bilinearly is
 * indistinguishable and costs a fraction.
 */

import * as THREE from "three";

import type { HeightSampler } from "./terrain";

export interface SunShadowOptions {
  /** World-space centre of the covered square. */
  centerX: number;
  centerZ: number;
  /** Side length of the covered square, in world units. */
  size: number;
  /** Texels per side. */
  resolution: number;
  /** How far to march toward the sun, in world units. */
  reach: number;
  /** Marching steps. More is smoother along the shadow's length, not its edge. */
  steps: number;
  /**
   * Softness of the terminator, in world units of height. The march records how
   * close it came to being blocked rather than a hard yes/no, so the edge has a
   * penumbra instead of a staircase.
   */
  softness: number;
}

export interface SunShadowMap {
  texture: THREE.DataTexture;
  /** Bottom-left corner of the covered square. */
  origin: THREE.Vector2;
  size: number;
  dispose: () => void;
}

export const createSunShadowMap = (
  getYPosition: HeightSampler,
  sunDirection: THREE.Vector3,
  options: SunShadowOptions,
): SunShadowMap => {
  const { centerX, centerZ, size, resolution, reach, steps, softness } = options;

  const originX = centerX - size / 2;
  const originZ = centerZ - size / 2;
  const step = size / (resolution - 1);

  // Horizontal march direction, and how fast the ray to the sun climbs per
  // world unit travelled along it.
  const horizontal = Math.hypot(sunDirection.x, sunDirection.z);
  const dirX = horizontal > 1e-6 ? sunDirection.x / horizontal : 1;
  const dirZ = horizontal > 1e-6 ? sunDirection.z / horizontal : 0;
  const climb = horizontal > 1e-6 ? sunDirection.y / horizontal : 1e6;

  const data = new Uint8Array(resolution * resolution);
  const marchStep = reach / steps;

  for (let row = 0; row < resolution; row++) {
    const z = originZ + row * step;
    for (let column = 0; column < resolution; column++) {
      const x = originX + column * step;
      const height = getYPosition(x, z);

      // Deepest intrusion of the terrain above the ray, over the whole march.
      let blocked = 0;
      for (let s = 1; s <= steps; s++) {
        const travelled = s * marchStep;
        const rayHeight = height + travelled * climb;
        const terrain = getYPosition(x + dirX * travelled, z + dirZ * travelled);
        const intrusion = terrain - rayHeight;
        if (intrusion > blocked) blocked = intrusion;
      }

      const shadow = Math.min(Math.max(blocked / softness, 0), 1);
      data[row * resolution + column] = Math.round((1 - shadow) * 255);
    }
  }

  const texture = new THREE.DataTexture(
    data,
    resolution,
    resolution,
    THREE.RedFormat,
    THREE.UnsignedByteType,
  );
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
  // Outside the baked square there is nothing to cast a shadow worth having, so
  // the edge texel repeats rather than wrapping a shadow round to the far side.
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.needsUpdate = true;

  return {
    texture,
    origin: new THREE.Vector2(originX, originZ),
    size,
    dispose: () => texture.dispose(),
  };
};
